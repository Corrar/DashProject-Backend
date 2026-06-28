# Dash — Backend (Render + Neon, auth próprio)

Backend de produção para o Dash: **auth próprio** (JWT access + refresh rotativo, bcrypt),
**Asaas** com **dois trilhos de cobrança** (cartão recorrente + Pix/boleto manual) e **3 tiers de plano**
(`free` / `essencial` / `pro`), além de **ferramenta paga gateada com quota mensal de IA** (narrativa Gemini).
Sem Supabase. Banco em **Neon**, deploy em **Render**.

Stack: Node 20+, TypeScript strict, Express 5, `pg` (pool raw), zod, jsonwebtoken, bcryptjs, helmet.
Pagamentos via **Asaas** (REST, sem SDK).

## Planos (fonte da verdade: `src/plans.ts`)

| Plano | IA/mês | maxRows | export | shareLinks | sem marca | R$/mês |
|---|---|---|---|---|---|---|
| `free` | 3 | 5.000 | ✗ | ✗ | ✗ | 0 |
| `essencial` | 50 | 100.000 | ✓ | ✗ | ✗ | 29,90 |
| `pro` | 300 | 1.000.000 | ✓ | ✓ | ✓ | 49,90 |

Os limites e valores de cobrança saem **só** de `src/plans.ts` — não de env. O gate é por
nível (`rank`): `requirePlan('essencial')` libera qualquer pago; `requirePlan('pro')` só Pro.
A **quota de IA** é medida server-side contando `ai_usage` do mês corrente; ao estourar o cap do
tier, `POST /tools/analyze` responde **429** `{ error:'quota_ia_excedida', limite, usados }`.

## Trilhos de cobrança (Asaas)

Há **dois caminhos**, espelhando limitações reais do Asaas confirmadas no sandbox:

**1) Cartão — assinatura recorrente.** `POST /billing/checkout {plan, method:'card'}` cria um
Checkout hospedado `RECURRENT` (o Asaas **só aceita `CREDIT_CARD` em recorrência**). A renovação
mensal é automática e **gerida pelos webhooks do Asaas**. O downgrade ocorre quando a assinatura é
cancelada/inativada (`SUBSCRIPTION_DELETED` / `SUBSCRIPTION_INACTIVATED`).

**2) Pix/boleto — manual.** `POST /billing/checkout {plan, method:'pix'}` cria um Checkout hospedado
avulso (`DETACHED`) **só com PIX** (o Checkout API **rejeita BOLETO**). A 1ª cobrança coleta o CPF na
página do Asaas e cria o `customer`. As **renovações** são geradas pelo job (`/jobs/billing-tick`) via
`POST /v3/payments` reusando esse `customer` — aí sim **PIX ou BOLETO**. Cada ciclo é registrado em
`billing_cycles` e estende `current_period_end` em +30 dias.

> **Nenhum** dos trilhos coleta CPF no frontend — o Checkout hospedado coleta.

**Política de inadimplência:** o webhook **não derruba** o plano no vencimento (`PAYMENT_OVERDUE`
apenas marca o ciclo como `OVERDUE`). O **downgrade efetivo é do job**, pela regra de período:
`current_period_end + GRACE_DAYS < now`. O trilho cartão **não** é tocado pelo job (é gerido pelos
webhooks).

## Rotas

| Método | Rota | Acesso | Função |
|---|---|---|---|
| GET  | `/health` | público | healthcheck / alvo de keepalive |
| POST | `/auth/signup` | público | cria conta + envia e-mail de verificação |
| POST | `/auth/login` | público | autentica; seta cookie de refresh |
| POST | `/auth/refresh` | cookie | rotaciona refresh, devolve novo access |
| POST | `/auth/logout` | cookie | revoga refresh |
| POST | `/auth/verify-email` | público | confirma e-mail via token |
| POST | `/auth/request-reset` | público | dispara e-mail de reset |
| POST | `/auth/reset` | público | redefine senha via token |
| GET  | `/me` | Bearer | perfil + `plan` + `limits` (gate de UX no frontend) |
| POST | `/billing/checkout` | Bearer | cria Checkout Asaas (`{plan, method:'card'\|'pix'}` → `{url}`) |
| POST | `/billing/cancel` | Bearer + pago | cancela a assinatura no Asaas (trilho cartão) |
| POST | `/billing/webhook` | token Asaas (header) | **única** fonte que escreve `plan` |
| POST | `/jobs/billing-tick` | header `x-jobs-secret` | cron diário: gera renovações Pix/boleto, lembretes e downgrade |
| POST | `/tools/analyze` | Bearer + **pago** | narrativa Gemini (gate + quota mensal de IA) |

## Subir local

```bash
cp .env.example .env      # preencha DATABASE_URL (Neon), APP_URL, JWT_ACCESS_SECRET
npm install
npm run migrate           # aplica migrations no Neon
npm run dev               # http://localhost:8787/health
```

Gerar um segredo JWT forte:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Deploy no Render

1. Suba este diretório num repo Git.
2. Render → New → Blueprint (usa `render.yaml`) → conecta o repo.
3. Preencha as env `sync:false` (DATABASE_URL do Neon, APP_URL, API_URL, CORS_ORIGIN, `ASAAS_API_KEY`, `ASAAS_ENV`, `ASAAS_WEBHOOK_TOKEN`, `JOBS_SECRET`, chaves Resend/Gemini). `RENEWAL_LEAD_DAYS` (5) e `GRACE_DAYS` (3) têm default.
4. `JWT_ACCESS_SECRET` é gerado automaticamente pelo Render.
5. Rode as migrations uma vez (local, apontando `DATABASE_URL` para o Neon de produção): `npm run migrate`.

**Render free hiberna após 15 min** → configure um keepalive (UptimeRobot) batendo em `GET /health` a cada ~10 min.

## Webhook e Job em produção

**Webhook (Asaas → backend):** no painel do Asaas (**Configurações → Integrações → Webhooks**) cadastre
a URL `https://<API_URL>/billing/webhook`, ative os eventos de pagamento e de assinatura, e defina o
**Token de autenticação** = o mesmo valor de `ASAAS_WEBHOOK_TOKEN`. O Asaas envia esse token no header
`asaas-access-token`; o backend rejeita (401) se não bater.
- **Teste local:** `ngrok http 8787` e cadastre `https://<ngrok>/billing/webhook` (a URL precisa ser HTTPS pública).

**Job de cobrança (cron externo):** `POST https://<API_URL>/jobs/billing-tick` com header
`x-jobs-secret: <JOBS_SECRET>` deve ser chamado por um **cron externo** (ex.: cron-job.org) **1×/dia**.
É idempotente (pode rodar várias vezes). Ele (A) gera as renovações Pix/boleto que vencem em até
`RENEWAL_LEAD_DAYS`, (B) envia lembretes nos marcos e (C) faz o downgrade após `GRACE_DAYS`.
- **No Render free** isso é essencial: o serviço hiberna após 15 min e **não dispara timers internos** —
  o cron externo ao bater no endpoint também **acorda o serviço** para processar o tick.

Detalhes de integração do frontend e setup de Asaas/Resend/Gemini: ver `CLAUDE_CODE.md`.
