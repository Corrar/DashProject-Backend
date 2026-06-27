# Dash — Backend (Render + Neon, auth próprio)

Backend de produção para o Dash: **auth próprio** (JWT access + refresh rotativo, bcrypt),
**Stripe** (checkout, portal, webhook idempotente) e **ferramenta paga gateada** (narrativa Gemini).
Sem Supabase. Banco em **Neon**, deploy em **Render**.

Stack: Node 20+, TypeScript strict, Express 5, `pg` (pool raw), zod, jsonwebtoken, bcryptjs, stripe, helmet.

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
| GET  | `/me` | Bearer | perfil do usuário (hidrata o frontend) |
| POST | `/billing/checkout` | Bearer | cria Stripe Checkout Session |
| POST | `/billing/portal` | Bearer + Pro | abre Customer Portal |
| POST | `/billing/webhook` | assinatura Stripe | **única** fonte que escreve `plan` |
| POST | `/tools/analyze` | Bearer + **Pro** | narrativa Gemini (ferramenta paga) |

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
3. Preencha as env `sync:false` (DATABASE_URL do Neon, APP_URL, API_URL, CORS_ORIGIN, chaves Stripe/Resend/Gemini).
4. `JWT_ACCESS_SECRET` é gerado automaticamente pelo Render.
5. Rode as migrations uma vez (local, apontando `DATABASE_URL` para o Neon de produção): `npm run migrate`.

**Render free hiberna após 15 min** → configure um keepalive (UptimeRobot) batendo em `GET /health` a cada ~10 min.

Detalhes de integração do frontend e setup de Stripe/Resend/Gemini: ver `CLAUDE_CODE.md`.
