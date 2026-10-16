# Dash — backend (CLAUDE.md)

O estado do projeto e os próximos passos ficam no `CLAUDE.md` do frontend
(`DashProject-Frontend`, seção 24 "Onde paramos"). As rotas estão no README.

Regras deste repositório:

- **Migrations idempotentes e não destrutivas**: `migrations/run.ts` reaplica
  todos os `.sql` a cada execução (`if not exists`, `do $$ … $$` para
  constraints). Rode duas vezes num Postgres local antes de commitar.
- **O plano só muda por `setPlan`** (`src/billing/asaas.ts`), que liga o GUC
  `app.billing='on'`; o trigger `guard_billing_columns` barra qualquer outro
  caminho. Webhook do Asaas é a fonte da verdade do pagamento.
- **Sessões**: refresh token rotativo por família (`family_id` = sessão, vai
  como `sid` no access token). Revogação de propósito usa `revoked_reason`
  (`logout`, `session_end`, `reset`); só reapresentar token `rotated` é roubo.
- Dados do usuário que saem do servidor (export, logs) nunca levam hash de
  senha; logs não levam conteúdo de planilha.
- Testes: `scripts/smoke/` (README lá). `npx tsc --noEmit -p .` antes de commitar.
- Commits e PRs sem identificador de modelo; PR só quando o dono pedir.
