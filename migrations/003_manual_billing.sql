-- 003_manual_billing.sql — trilho manual Pix/boleto (por cima do trilho cartão recorrente).
-- Forward-only. Não regride o cartão; adiciona método de billing + ciclos de cobrança.
begin;

-- billing_method no profile. current_period_end foi removido em 002; o trilho manual precisa
-- dele de volta para controlar expiração por período (epoch via setPlan).
alter table profiles add column if not exists billing_method     text check (billing_method in ('card','pix','boleto'));
alter table profiles add column if not exists current_period_end timestamptz;

-- Ciclos de cobrança do trilho manual (Pix/boleto). UNIQUE(user_id, period_start) =
-- idempotência da geração (nunca 2 cobranças para o mesmo período).
create table if not exists billing_cycles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  plan             text not null,
  billing_type     text not null check (billing_type in ('PIX','BOLETO')),
  asaas_payment_id text unique,
  value            numeric(10,2) not null,
  due_date         date,
  period_start     date not null,
  period_end       date not null,
  status           text not null default 'PENDING' check (status in ('PENDING','PAID','OVERDUE','CANCELED')),
  invoice_url      text,
  reminders        jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, period_start)
);
create index if not exists idx_billing_cycles_user   on billing_cycles(user_id, period_start);
create index if not exists idx_billing_cycles_status on billing_cycles(status);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists trg_touch_billing_cycles on billing_cycles;
create trigger trg_touch_billing_cycles before update on billing_cycles
  for each row execute function touch_updated_at();

-- Guard de billing: agora também protege billing_method e current_period_end (só mudam via
-- setPlan com app.billing='on').
create or replace function guard_billing_columns()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.billing', true), 'off') <> 'on' then
    if new.plan                  is distinct from old.plan
    or new.asaas_customer_id     is distinct from old.asaas_customer_id
    or new.asaas_subscription_id is distinct from old.asaas_subscription_id
    or new.billing_method        is distinct from old.billing_method
    or new.current_period_end    is distinct from old.current_period_end then
      raise exception 'Colunas de billing so mudam via fluxo de billing (app.billing!=on)'
        using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists trg_guard_billing on profiles;
create trigger trg_guard_billing
  before update on profiles for each row execute function guard_billing_columns();

commit;
