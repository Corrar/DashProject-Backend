-- 006_annual_and_cancel.sql — plano anual + cancelamento que mantém o acesso até o fim do período.
-- Forward-only e idempotente (o runner reaplica todos os .sql a cada execução).
begin;

-- Ciclo de cobrança do assinante e se a assinatura vai renovar. auto_renew=false = cancelou no
-- cartão mas ainda está dentro do período pago; o job derruba para Free quando o período acaba.
alter table profiles add column if not exists billing_cycle text not null default 'monthly';
alter table profiles add column if not exists auto_renew boolean not null default true;
alter table checkout_sessions add column if not exists cycle text not null default 'monthly';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_billing_cycle_check') then
    alter table profiles add constraint profiles_billing_cycle_check check (billing_cycle in ('monthly','yearly'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'checkout_sessions_cycle_check') then
    alter table checkout_sessions add constraint checkout_sessions_cycle_check check (cycle in ('monthly','yearly'));
  end if;
end $$;

-- Guard de billing: agora também protege billing_cycle e auto_renew (só mudam via setPlan com
-- app.billing='on').
create or replace function guard_billing_columns()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.billing', true), 'off') <> 'on' then
    if new.plan                  is distinct from old.plan
    or new.asaas_customer_id     is distinct from old.asaas_customer_id
    or new.asaas_subscription_id is distinct from old.asaas_subscription_id
    or new.billing_method        is distinct from old.billing_method
    or new.current_period_end    is distinct from old.current_period_end
    or new.billing_cycle         is distinct from old.billing_cycle
    or new.auto_renew            is distinct from old.auto_renew then
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
