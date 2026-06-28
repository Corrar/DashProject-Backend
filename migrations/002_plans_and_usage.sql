-- 002_plans_and_usage.sql — 3 tiers (free/essencial/pro) + uso de IA + troca Stripe→Asaas.
-- Forward-only. Preserva linhas existentes ('pro' continua 'pro').
begin;

-- 1) profiles.plan: free|pro  ->  free|essencial|pro (constraint inline de 001 = profiles_plan_check).
alter table profiles drop constraint if exists profiles_plan_check;
alter table profiles add constraint profiles_plan_check check (plan in ('free','essencial','pro'));

-- 2) Colunas Asaas. Removemos as colunas específicas do Stripe (Stripe foi descontinuado).
alter table profiles add column if not exists asaas_customer_id     text unique;
alter table profiles add column if not exists asaas_subscription_id text;
alter table profiles drop column if exists stripe_customer_id;
alter table profiles drop column if exists stripe_subscription_id;
alter table profiles drop column if exists current_period_end;

-- 3) Consumo de IA: append-only. O uso do mês é DERIVADO por contagem (sem cron de reset).
create table if not exists ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_user_month on ai_usage(user_id, created_at);

-- 4) Idempotência de webhooks: renomeia a tabela do Stripe para nome neutro de provedor.
--    Idempotente: 001 recria processed_stripe_events a cada run, então só renomeia se o destino
--    ainda não existe; caso contrário descarta a tabela antiga recriada.
do $$
begin
  if to_regclass('public.processed_webhook_events') is null then
    alter table if exists processed_stripe_events rename to processed_webhook_events;
  else
    drop table if exists processed_stripe_events;
  end if;
end $$;
create table if not exists processed_webhook_events (
  event_id     text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

-- 5) Guard de defesa-em-profundidade: colunas de billing só mudam quando a transação
--    seta o GUC app.billing='on' (só o fluxo de billing/webhook faz isso). Agora protege
--    plan + as colunas Asaas (as colunas Stripe deixaram de existir).
create or replace function guard_billing_columns()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.billing', true), 'off') <> 'on' then
    if new.plan                  is distinct from old.plan
    or new.asaas_customer_id     is distinct from old.asaas_customer_id
    or new.asaas_subscription_id is distinct from old.asaas_subscription_id then
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
