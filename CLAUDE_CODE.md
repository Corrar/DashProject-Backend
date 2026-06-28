# Brief para o Claude Code — Dash: backend próprio (Render + Neon) + integração do frontend

Você (Claude Code) vai executar duas frentes:
- **Parte A:** preparar e fazer deploy deste backend (pasta `dash-backend/`).
- **Parte B:** migrar o frontend do Supabase para este backend, **no branch `design-v2-integration`** do repo do Dash.

Arquitetura final: frontend estático (CDN React + Babel standalone, **sem bundler**) na Vercel → API Node/Express na Render → Postgres na Neon. **Asaas** cuida da cobrança em **dois trilhos** — (1) **cartão recorrente** (assinatura, renovação automática pelos webhooks) e (2) **Pix/boleto manual** (entrada por Checkout hospedado só-Pix; renovações geradas por um job via `POST /payments`) — com **3 tiers** (`free`/`essencial`/`pro`) e **quota mensal de IA**. **Supabase é removido por completo.**

> Regras inegociáveis:
> - **Nunca** commitar segredos (chave Asaas/Gemini/Resend, token de webhook, JWT secret, DATABASE_URL). Use env do Render / `.env` local (já no `.gitignore`).
> - **Manter o frontend no branch `design-v2-integration`** (é a fonte da verdade, está à frente do `main`).
> - O frontend é **CDN + Babel standalone**: componentes são funções globais, config vem de `window.*`. **Não** introduza `import`/bundler/Vite.
> - Não altere a identidade visual nem o layout — só a camada de dados (auth, perfil, IA, billing).

---

## PARTE A — Backend

### A1. Banco (Neon)
1. Crie um projeto/branch no Neon e copie a connection string (com `?sslmode=require`).
2. Em `dash-backend/`: `cp .env.example .env` e preencha no mínimo `DATABASE_URL`, `APP_URL`, `JWT_ACCESS_SECRET`.
   - Gere o segredo: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
3. `npm install`
4. `npm run migrate` (aplica `migrations/001_init.sql`)
5. `npm run typecheck` (deve passar) e `npm run dev` → confirme `GET http://localhost:8787/health` = `{"ok":true}`.

### A2. Asaas (pagamentos) — DOIS trilhos
> Os **valores** dos planos vêm de `src/plans.ts` (`asaasValue`: essencial R$ 29,90 / pro R$ 49,90), **não** de env. Não há produto/price a criar no painel.
1. Crie a conta Asaas e gere a **API key** (Configurações → Integrações) → `ASAAS_API_KEY`.
2. Defina `ASAAS_ENV=sandbox` (testes) ou `production`. O backend escolhe a base automaticamente (`https://api-sandbox.asaas.com/v3` ou `https://api.asaas.com/v3`). Auth pelo header `access_token`.

**`POST /billing/checkout` aceita `{ plan, method }`** e devolve `{ url }` (campo `link` do Asaas). Em ambos os trilhos: **não enviamos `customerData`** (a página hospedada coleta nome/CPF/telefone/endereço — **o frontend NÃO coleta CPF**); o `callback` exige **URLs HTTPS públicas** (`APP_URL` https — localhost é rejeitado); `externalReference = user.id` propaga p/ assinatura/cobrança e volta no webhook (vínculo confiável). Tudo confirmado no sandbox.

- **Trilho CARTÃO (`method:'card'`):** Checkout `RECURRENT` mensal. O Asaas **só aceita `billingTypes:['CREDIT_CARD']` em recorrência**. A renovação é **automática, gerida pelos webhooks** do Asaas. Downgrade quando a assinatura é cancelada/inativada.
- **Trilho MANUAL (`method:'pix'`):** Checkout `DETACHED` **só com `['PIX']`** (o Checkout API **rejeita BOLETO**). A 1ª cobrança cria o `customer`; as **renovações** são geradas pelo **job** (`/jobs/billing-tick`) via `POST /v3/payments` reusando o `customer` — aí sim **PIX ou BOLETO** (ambos confirmados no sandbox: `invoiceUrl` é a URL hospedada; boleto também tem `bankSlipUrl`; QR do Pix em `GET /v3/payments/{id}/pixQrCode`). Cada ciclo vira uma linha em `billing_cycles` e estende `current_period_end` em +30 dias.

3. **Webhook:** valida o token no header `asaas-access-token` (== `ASAAS_WEBHOOK_TOKEN`); idempotência pelo `id` (`evt_...`) do evento (`processed_webhook_events`). **Não há HMAC** (diferente do Stripe). Mapeamento:
   - `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` → ativa o tier (descoberto pelo **valor** da cobrança); registra/estende período. `billingType`→método (`CREDIT_CARD→card`, `PIX→pix`, `BOLETO→boleto`).
   - `SUBSCRIPTION_DELETED`/`SUBSCRIPTION_INACTIVATED` (cartão) → `free`.
   - **`PAYMENT_OVERDUE` NÃO derruba na hora** — só marca o `billing_cycle` como `OVERDUE`. O downgrade efetivo do trilho manual é do **job** (regra de período + `GRACE_DAYS`). O trilho cartão **não** é tocado pelo job.

### A2b. Webhook e Job em produção
- **Webhook:** no painel do Asaas (**Configurações → Integrações → Webhooks**) cadastre `https://<API_URL>/billing/webhook`, ative os eventos de pagamento/assinatura e defina o **Token de autenticação** = mesmo valor de `ASAAS_WEBHOOK_TOKEN`. **Teste local:** `ngrok http 8787` e cadastre `https://<ngrok>/billing/webhook` (precisa ser HTTPS pública).
  - ⚠️ **`PAYMENT_CONFIRMED` é OBRIGATÓRIO** nos eventos do webhook. No **cartão**, é o `PAYMENT_CONFIRMED` (na captura/autorização) que libera o acesso — o `PAYMENT_RECEIVED` do cartão só chega na **liquidação, dias depois** (validado no sandbox: `creditDate` ~+30d). Sem `PAYMENT_CONFIRMED` habilitado, o assinante de cartão ficaria sem acesso até a liquidação. Habilite também `PAYMENT_RECEIVED` (Pix/boleto liberam por ele) e os eventos de assinatura (`SUBSCRIPTION_DELETED`/`SUBSCRIPTION_INACTIVATED`).
  - **Amarração:** o Checkout hospedado **não** devolve `externalReference` no pagamento; o vínculo é por `payment.checkoutSession` (mapa `checkout_sessions`, gravado na criação do checkout). No 1º pagamento gravamos `asaas_customer_id`/`asaas_subscription_id`, então os eventos seguintes resolvem direto por customer/subscription.
- **Job de cobrança:** `POST https://<API_URL>/jobs/billing-tick` com header `x-jobs-secret: <JOBS_SECRET>` deve ser chamado por um **cron externo** (ex.: cron-job.org) **1×/dia**. É idempotente. Faz (A) geração das renovações Pix/boleto que vencem em até `RENEWAL_LEAD_DAYS` (5), (B) lembretes nos marcos e (C) downgrade após `GRACE_DAYS` (3). **No Render free** isso é essencial: o serviço hiberna após 15 min e **não dispara timers internos** — o cron externo também **acorda o serviço** ao bater no endpoint.

### A3. Resend (e-mail — Render free bloqueia SMTP)
1. Crie a API key → `RESEND_API_KEY`. Configure um remetente verificado → `EMAIL_FROM`.
2. Sem `RESEND_API_KEY` o backend não quebra: ele **loga** o link de verificação/reset (modo dev).

### A4. Gemini
1. `GEMINI_API_KEY` (Google AI Studio). `GEMINI_MODEL` default `gemini-2.5-flash`.

### A5. Deploy na Render
1. Suba `dash-backend/` num repo Git (pode ser subpasta ou repo dedicado).
2. Render → **New → Blueprint** (usa `render.yaml`) → conecte o repo.
3. Preencha as env marcadas `sync:false`: `DATABASE_URL`, `APP_URL` (URL do frontend Vercel), `API_URL` (a própria URL do serviço Render), `CORS_ORIGIN` (inclua a origem exata do frontend Vercel), `ASAAS_API_KEY`, `ASAAS_ENV` (`production`), `ASAAS_WEBHOOK_TOKEN`, `JOBS_SECRET`, e as chaves Resend/Gemini. `RENEWAL_LEAD_DAYS` (5) e `GRACE_DAYS` (3) têm default no `render.yaml`. `JWT_ACCESS_SECRET` é gerado pelo Render.
4. Rode as migrations apontando para o Neon de produção: `DATABASE_URL=<neon-prod> npm run migrate`.
5. **Webhook + Job:** configure-os no Asaas/cron conforme **A2b** (o cron do `/jobs/billing-tick` também serve de keepalive).
6. **Keepalive:** crie um monitor no UptimeRobot batendo em `GET https://<API_URL>/health` a cada ~10 min (mitiga o cold start de 30–60s do plano free).

---

## PARTE B — Frontend (branch `design-v2-integration`)

Faça `git checkout design-v2-integration` antes de tudo. As mudanças são cirúrgicas: trocar todas as chamadas Supabase por chamadas a este backend, via um cliente único `window.DashAPI`.

### B1. Criar `components/api.js`
Crie o arquivo abaixo **exatamente**. Ele guarda o access token em memória, anexa `Authorization`, manda o cookie de refresh (`credentials:'include'`) e faz auto-refresh em 401.

```javascript
// components/api.js — cliente da API Dash (backend próprio). Carregar ANTES dos componentes.
(function () {
  const BASE = window.__API_URL;
  let accessToken = null;
  const listeners = new Set();

  function setToken(t) { accessToken = t; }
  function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(user) { listeners.forEach((fn) => fn(user)); }

  async function refresh() {
    try {
      const res = await fetch(BASE + '/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) { setToken(null); return false; }
      const data = await res.json();
      setToken(data.access_token);
      return true;
    } catch (e) { setToken(null); return false; }
  }

  async function raw(path, opts, retry) {
    opts = opts || {}; if (retry === undefined) retry = true;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
    const res = await fetch(BASE + path, Object.assign({}, opts, { headers, credentials: 'include' }));
    if (res.status === 401 && retry && path !== '/auth/refresh') {
      if (await refresh()) return raw(path, opts, false);
    }
    return res;
  }

  async function json(path, opts) {
    const res = await raw(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'erro'), { status: res.status, data: data });
    return data;
  }

  window.DashAPI = {
    onAuthChange: onAuthChange,
    async signup(email, password, fullName) {
      const d = await json('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, full_name: fullName }) });
      setToken(d.access_token); emit(d.user); return d.user;
    },
    async login(email, password) {
      const d = await json('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setToken(d.access_token); emit(d.user); return d.user;
    },
    async logout() { try { await json('/auth/logout', { method: 'POST' }); } finally { setToken(null); emit(null); } },
    async me() {
      if (!accessToken && !(await refresh())) { emit(null); return null; }
      try { const u = await json('/me'); emit(u); return u; }
      catch (e) { if (e.status === 401) { setToken(null); emit(null); return null; } throw e; }
    },
    verifyEmail(token) { return json('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }); },
    requestReset(email) { return json('/auth/request-reset', { method: 'POST', body: JSON.stringify({ email }) }); },
    resetPassword(token, password) { return json('/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) }); },
    async checkout(plan, method) { const d = await json('/billing/checkout', { method: 'POST', body: JSON.stringify({ plan, method: method || 'card' }) }); window.location.href = d.url; },
    async cancel() { return json('/billing/cancel', { method: 'POST' }); },
    analyze(payload) { return json('/tools/analyze', { method: 'POST', body: JSON.stringify(payload) }); },
  };
})();
```

### B2. `Dash.html`
1. **Remover** a tag `<script>` do `supabase-js` (CDN) e o bloco que inicializa `window.supabaseClient` com a `anon key`.
2. **Adicionar**, antes dos scripts dos componentes:
   ```html
   <script>window.__API_URL = "https://<API_URL_DA_RENDER>";</script>
   <script src="components/api.js"></script>
   ```
   (`api.js` é JS puro — carregue como script normal, não como `text/babel`. Garanta que vem **antes** de `app.jsx`.)
3. **Deep links de e-mail** (verificação e reset): no boot da app, leia a query string.
   - Se `?verify=<token>`: chame `window.DashAPI.verifyEmail(token)`, mostre toast de sucesso e limpe a URL.
   - Se `?reset=<token>`: abra um formulário "nova senha" → `window.DashAPI.resetPassword(token, novaSenha)`.
   - Se `?upgrade=ok`: recarregue o perfil (`DashAPI.me()`) e mostre confirmação de Pro ativo.

### B3. `app.jsx`
Substitua a camada de sessão do Supabase:
- **Remover** `supabaseClient.auth.getSession()`, `supabaseClient.auth.onAuthStateChange(...)` e a função `loadUserProfile` (que fazia `supabaseClient.from('profiles').select(...)`).
- No mount (efeito inicial), chame `await window.DashAPI.me()` e use o retorno para setar `currentUser`. O shape agora é `{ id, email, fullName, plan, emailVerified }`.
- Inscreva-se em mudanças: `const off = window.DashAPI.onAuthChange(setCurrentUser); return off;`
- Onde antes havia `onSignIn`/`onSignUp`/`onSignOut`, encaminhe para `DashAPI.login/signup/logout` (a `auth-view` já chama a API direto — veja B4 — então aqui basta reagir ao `onAuthChange`).
- O gate de upgrade (`__dashUpgrade`/`openPlans`) continua igual no nível de UI; o bloqueio real é server-side.

### B4. `auth-view.jsx` e `auth-modal.jsx`
Troque as chamadas Supabase pelas do cliente:
- `supabaseClient.auth.signInWithPassword({ email, password })` → `await window.DashAPI.login(email, password)`
- `supabaseClient.auth.signUp({ email, password, options: { data: { full_name } } })` → `await window.DashAPI.signup(email, password, fullName)`
- Mantenha o fluxo visual "confirme seu e-mail": após `signup`, o usuário existe mas `emailVerified=false` (o e-mail de verificação já foi disparado pelo backend). Exiba o card de sucesso como hoje.
- Trate erros pelo `error.status`/`error.data.error` (ex.: `email_em_uso` → "e-mail já cadastrado"; `credenciais_invalidas` → "e-mail ou senha incorretos"; `senha_fraca` → "mínimo 8 caracteres").

> **Planos/limites no frontend:** `DashAPI.me()` agora devolve `plan` e um objeto `limits` (`aiMonthly`, `aiUsed`, `maxRows`, `canExport`, `shareLinks`, `removeBranding`). Use `limits` para o gate de UX (mostrar uso de IA, travar export/share conforme o tier). O bloqueio real continua server-side.

### B5. `dashboard.jsx` (a IA)
Localize a chamada (≈ linha 249):
```js
window.supabaseClient.functions.invoke("gemini-narrative", { body: { ... } })
```
Substitua por:
```js
const result = await window.DashAPI.analyze({
  datasetName,                 // nome do arquivo/dataset, se houver
  columns,                     // [{ name, type? }, ...]
  sampleRows,                  // array de objetos; o backend usa as 20 primeiras linhas
  question,                    // pergunta do usuário, se houver
});
// result = { narrative: string, model: string }
```
- Mapeie o schema atual (as ~20 linhas cruas do §8 do CLAUDE.md) para `columns` + `sampleRows`.
- **Tratamento do gate:** se `error.status === 402` (`plano_insuficiente`), dispare o fluxo de upgrade (abrir planos / checkout) — é o paywall de tier. Se `error.status === 429` (`quota_ia_excedida`, com `error.data.limite`/`usados`), mostre "limite de IA do mês atingido" e ofereça upgrade para um tier com mais cota.

### B6. `plans-view.jsx`
- Agora há **3 tiers** e, em cada plano pago, **dois caminhos** de pagamento:
  - **"Cartão (renova automático)"** → `await window.DashAPI.checkout(plan, 'card')` — assinatura recorrente no cartão.
  - **"Pix (mensal)"** → `await window.DashAPI.checkout(plan, 'pix')` — Checkout Pix avulso; as renovações chegam por e-mail (Pix/boleto) gerenciadas pelo backend.
  - `plan` = `'essencial'` ou `'pro'`. Ambos redirecionam para o Checkout hospedado do Asaas.
- Os preços exibidos devem bater com `src/plans.ts` (essencial R$ 29,90/mês, pro R$ 49,90/mês). A cobrança real usa `PLANS[plan].asaasValue` — não há `price_...` de provedor.

### B7. `account-view.jsx`
- O botão de cancelar assinatura deve chamar `await window.DashAPI.cancel()` e, em seguida, `DashAPI.me()` para reidratar o plano (o downgrade para `free` chega pelo webhook do Asaas — pode levar alguns instantes).
- **Remova o `ComingSoonOverlay`** da seção de billing (o backend agora existe).
- Exiba `plan` e o uso de IA do mês (`limits.aiUsed` / `limits.aiMonthly`) vindos do `/me`.

---

## PARTE C — Checklist de verificação (rode após A+B)

1. **Signup → verificação:** cadastre um e-mail; confira o e-mail (ou o log, em dev); abra `?verify=<token>`; `emailVerified` vira `true`.
2. **Login + refresh:** faça login; recarregue a página; `DashAPI.me()` deve reidratar a sessão (via cookie de refresh) sem novo login.
3. **Gate free:** com usuário **free**, dispare a análise → backend responde **402** (`plano_insuficiente`) e o frontend abre o fluxo de upgrade.
4. **Checkout cartão (sandbox):** `POST /billing/checkout {plan:'pro', method:'card'}` → abra a `url` → pague com cartão de teste do Asaas → `?upgrade=ok`.
5. **Webhook:** confirme nos logs que o evento chegou com header `asaas-access-token` válido e que `profiles.plan` virou `pro` (tier pelo valor da cobrança).
6. **Ferramenta paga + quota:** análise como **pro** → narrativa retorna; ao exceder `aiMonthly` do tier → **429** (`quota_ia_excedida`).
7. **Cancelamento (cartão):** `POST /billing/cancel` → `SUBSCRIPTION_DELETED` → plano volta a `free` → análise volta a 402.
8. **Trilho manual (sandbox):** `checkout {plan:'pro', method:'pix'}` → pague o Pix → `PAYMENT_RECEIVED` → `plan=pro`, `billing_method='pix'`, `current_period_end=+30d`, `billing_cycle` `PAID`. Simule a virada: empurre `current_period_end` para dentro de `RENEWAL_LEAD_DAYS` e chame `/jobs/billing-tick` (com `x-jobs-secret`) → gera nova cobrança + e-mail; depois empurre para o passado além de `GRACE_DAYS` e rode o tick → **downgrade** para `free`.
9. **Logout:** revoga o refresh; `DashAPI.me()` passa a retornar `null`.

## Notas de segurança já embutidas no backend
- Refresh token é **opaco**, guardado só como hash, **rotacionado** a cada uso; reuso de token revogado mata a sessão inteira.
- `plan` (e `asaas_customer_id`/`asaas_subscription_id`) só mudam pelo fluxo de **billing/webhook** (trigger no Postgres bloqueia qualquer outra rota via GUC `app.billing`).
- Webhook do Asaas validado por **token no header** `asaas-access-token` + **idempotência** pelo `id` do evento (tabela `processed_webhook_events`).
- `requireAuth` relê o **plano real do banco** (cache de 30s), então o gate não confia no claim do JWT.
- Respostas de login/reset são **uniformes** para não revelar se um e-mail existe.
- CORS com origens **exatas** + credenciais; cookies `httpOnly`/`Secure`/`SameSite=None` em produção.
