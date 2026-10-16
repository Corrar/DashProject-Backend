# Testes de fumaça do backend

Sobem a API em uma porta local e conferem as rotas de ponta a ponta. O Asaas,
o Resend e o Gemini são simulados (o `fetch` é trocado no próprio script).
Ficam fora do build (`tsconfig.json` só compila `src/`).

| Script | Banco | Cobre |
|---|---|---|
| `smoke.ts`, `smoke_change.ts`, `smoke_share.ts` | simulado (`pool.query` trocado) | logout/reset, guardas do checkout, troca de plano, links públicos |
| `smoke_annual.ts` | Postgres real | IA grátis (1/mês), plano anual, cancelamento até o fim do período, job de renovação Pix |
| `smoke_account.ts` | Postgres real | perfil, senha, sessões, exportar, excluir conta, faturas, histórico de IA, lista de espera, rate limit |
| `smoke_reuse.ts` | Postgres real | reuso de refresh token rotacionado derruba só a família; logout não derruba as outras |
| `smoke_cleanup.ts` | Postgres real | limpeza diária de sessões e links de e-mail vencidos |

Postgres local descartável (a migração roda duas vezes para provar que é idempotente):

```bash
D=/var/lib/postgresql/dashtest; BIN=/usr/lib/postgresql/16/bin
su postgres -s /bin/bash -c "$BIN/initdb -D $D -A trust -U postgres && $BIN/pg_ctl -D $D -o '-p 55432 -k /var/lib/postgresql' -l $D.log start"
psql -h /var/lib/postgresql -p 55432 -U postgres -c 'create database dash'
DATABASE_URL=postgres://postgres@localhost:55432/dash PG_SSL=false npm run migrate   # 2x
npx tsx scripts/smoke/smoke_account.ts        # cada script imprime PASS/FAIL e "TUDO OK"
```

Outro banco: `SMOKE_DATABASE_URL=postgres://… npx tsx scripts/smoke/smoke_account.ts`.
Nunca aponte para o Neon de produção: os scripts apagam usuários de teste
(`*@smoke.test`, `*@acc.test`, `*@reuse.test`).
