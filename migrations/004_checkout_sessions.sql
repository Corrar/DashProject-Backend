-- 004_checkout_sessions.sql — amarração checkout→usuário (o Checkout hospedado NÃO propaga
-- externalReference para o pagamento; o webhook usa payment.checkoutSession como chave).
-- Forward-only. Não toca em plan/asaas_* → sem guard de billing.
begin;

create table if not exists checkout_sessions (
  checkout_id text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  plan        text not null,
  method      text not null check (method in ('card','pix')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_checkout_sessions_user on checkout_sessions(user_id);

commit;
