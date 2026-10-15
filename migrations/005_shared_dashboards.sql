-- 005_shared_dashboards.sql — links públicos de dashboard (recurso do plano Pro).
-- Forward-only e idempotente (o runner reaplica todos os .sql a cada execução).
-- Guarda só o RETRATO do dashboard (blocos com valores já agregados + metadados),
-- nunca as linhas do arquivo do usuário.
begin;

create table if not exists shared_dashboards (
  slug        text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index if not exists idx_shared_dashboards_user on shared_dashboards(user_id) where revoked_at is null;

commit;
