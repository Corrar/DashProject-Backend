-- 007_account.sql — sessões visíveis, exclusão de conta (LGPD) e lista de espera.
-- Forward-only e idempotente (o runner reaplica todos os .sql a cada execução).
begin;

-- Sessões: cada login abre uma "família" de refresh tokens; a rotação mantém a
-- família. Guardamos o dispositivo (user-agent) e o IP do último uso para a
-- tela "Sessões ativas" da conta. Linhas antigas ganham uma família própria.
alter table refresh_tokens add column if not exists family_id uuid not null default gen_random_uuid();
alter table refresh_tokens add column if not exists user_agent text;
alter table refresh_tokens add column if not exists ip text;
alter table refresh_tokens add column if not exists last_used_at timestamptz;
-- Por que foi revogado: só reapresentar um token ROTACIONADO indica roubo.
-- Token de sessão encerrada (logout, troca de senha, "encerrar sessão") só dá 401.
alter table refresh_tokens add column if not exists revoked_reason text;
create index if not exists idx_refresh_family on refresh_tokens(family_id) where revoked_at is null;

-- Exclusão de conta: os registros de cobrança ficam pelo prazo fiscal, mas sem
-- vínculo com a pessoa (só os identificadores do Asaas, que já guarda a cobrança).
create table if not exists billing_archive (
  id                uuid primary key default gen_random_uuid(),
  asaas_customer_id text,
  asaas_payment_id  text,
  plan              text not null,
  billing_type      text,
  value             numeric(10,2) not null,
  due_date          date,
  period_start      date,
  period_end        date,
  status            text,
  archived_at       timestamptz not null default now()
);

-- Lista de espera de recursos futuros (ex.: workspace do plano Team).
create table if not exists waitlist (
  user_id    uuid not null references users(id) on delete cascade,
  feature    text not null check (feature in ('workspace')),
  source     text,
  created_at timestamptz not null default now(),
  primary key (user_id, feature)
);

commit;
