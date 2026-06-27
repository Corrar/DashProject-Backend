# Brief para o Claude Code — Dash: backend próprio (Render + Neon) + integração do frontend

Você (Claude Code) vai executar duas frentes:
- **Parte A:** preparar e fazer deploy deste backend (pasta `dash-backend/`).
- **Parte B:** migrar o frontend do Supabase para este backend, **no branch `design-v2-integration`** do repo do Dash.

Arquitetura final: frontend estático (CDN React + Babel standalone, **sem bundler**) na Vercel → API Node/Express na Render → Postgres na Neon. Stripe cuida da assinatura. **Supabase é removido por completo.**

> Regras inegociáveis:
> - **Nunca** commitar segredos (chaves Stripe/Gemini/Resend, JWT secret, DATABASE_URL). Use env do Render / `.env` local (já no `.gitignore`).
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

### A2. Stripe
1. Crie um **Produto** "Dash Pro" com **preço recorrente mensal de R$ 29,00** (BRL). Copie o `price_...` → `STRIPE_PRICE_PRO`.
2. Copie a **Secret key** (`sk_...`) → `STRIPE_SECRET_KEY`.
3. Crie um **Webhook endpoint** apontando para `https://<API_URL>/billing/webhook`, assinando os eventos:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   Copie o **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.
4. (Teste local) use `stripe listen --forward-to localhost:8787/billing/webhook` e o `whsec_` que ele imprime.

### A3. Resend (e-mail — Render free bloqueia SMTP)
1. Crie a API key → `RESEND_API_KEY`. Configure um remetente verificado → `EMAIL_FROM`.
2. Sem `RESEND_API_KEY` o backend não quebra: ele **loga** o link de verificação/reset (modo dev).

### A4. Gemini
1. `GEMINI_API_KEY` (Google AI Studio). `GEMINI_MODEL` default `gemini-2.5-flash`.

### A5. Deploy na Render
1. Suba `dash-backend/` num repo Git (pode ser subpasta ou repo dedicado).
2. Render → **New → Blueprint** (usa `render.yaml`) → conecte o repo.
3. Preencha as env marcadas `sync:false`: `DATABASE_URL`, `APP_URL` (URL do frontend Vercel), `API_URL` (a própria URL do serviço Render), `CORS_ORIGIN` (inclua a origem exata do frontend Vercel), e as chaves Stripe/Resend/Gemini. `JWT_ACCESS_SECRET` é gerado pelo Render.
4. Rode as migrations apontando para o Neon de produção: `DATABASE_URL=<neon-prod> npm run migrate`.
5. **Keepalive:** crie um monitor no UptimeRobot batendo em `GET https://<API_URL>/health` a cada ~10 min (mitiga o cold start de 30–60s do plano free).

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
    async checkout() { const d = await json('/billing/checkout', { method: 'POST' }); window.location.href = d.url; },
    async portal() { const d = await json('/billing/portal', { method: 'POST' }); window.location.href = d.url; },
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
- **Tratamento do gate:** se `error.status === 402` (`plano_insuficiente`), dispare o fluxo de upgrade (abrir planos / checkout) em vez de mostrar erro genérico. Esse é o paywall real.

### B6. `plans-view.jsx`
- A prop `onSelectPro` deve chamar `await window.DashAPI.checkout()` (redireciona para o Stripe Checkout).
- Mantenha o preço exibido (R$ 29/mês, R$ 23 anual, trial 7 dias) — a cobrança real vem do `STRIPE_PRICE_PRO`.

### B7. `account-view.jsx`
- O botão de gerenciar assinatura/billing deve chamar `await window.DashAPI.portal()` (abre o Customer Portal).
- **Remova o `ComingSoonOverlay`** da seção de billing (o backend agora existe).
- Exiba `plan` e, se disponível, a data de renovação (campo derivado de `current_period_end`; se quiser expô-la, adicione ao `/me`).

---

## PARTE C — Checklist de verificação (rode após A+B)

1. **Signup → verificação:** cadastre um e-mail; confira o e-mail (ou o log, em dev); abra `?verify=<token>`; `emailVerified` vira `true`.
2. **Login + refresh:** faça login; recarregue a página; `DashAPI.me()` deve reidratar a sessão (via cookie de refresh) sem novo login.
3. **Gate free:** com usuário **free**, dispare a análise → backend responde **402** e o frontend abre o fluxo de upgrade.
4. **Checkout:** clique em assinar → Stripe Checkout (cartão de teste `4242 4242 4242 4242`, validade futura, CVC qualquer) → retorno em `?upgrade=ok`.
5. **Webhook:** confirme nos logs que `checkout.session.completed` chegou e que `profiles.plan` do usuário virou `pro`.
6. **Ferramenta paga:** repita a análise com o usuário agora **pro** → deve retornar a narrativa.
7. **Portal/cancelamento:** abra o portal, cancele → `customer.subscription.deleted` → plano volta a `free` → análise volta a dar 402.
8. **Logout:** revoga o refresh; `DashAPI.me()` passa a retornar `null`.

## Notas de segurança já embutidas no backend
- Refresh token é **opaco**, guardado só como hash, **rotacionado** a cada uso; reuso de token revogado mata a sessão inteira.
- `plan` só muda pelo **webhook** (trigger no Postgres bloqueia qualquer outra rota via GUC `app.billing`).
- `requireAuth` relê o **plano real do banco** (cache de 30s), então o gate não confia no claim do JWT.
- Respostas de login/reset são **uniformes** para não revelar se um e-mail existe.
- CORS com origens **exatas** + credenciais; cookies `httpOnly`/`Secure`/`SameSite=None` em produção.
