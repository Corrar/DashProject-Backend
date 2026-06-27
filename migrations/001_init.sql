-- 001_init.sql — schema do backend Dash (Neon). Auth próprio, sem Supabase, sem RLS
-- (o backend é o único cliente do banco; authz é feita em código).
begin;

create extension if not exists pgcrypto;  -- gen_random_uuid()

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  email_verified boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists profiles (
  id                     uuid primary key references users(id) on delete cascade,
  full_name              text,
  plan                   text not null default 'free' check (plan in ('free','pro')),
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Refresh tokens rotativos: guarda só o hash, nunca o valor em claro.
create table if not exists refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_refresh_user on refresh_tokens(user_id) where revoked_at is null;

-- Tokens de e-mail (verificação + reset): hash, expiração e uso único.
create table if not exists email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  purpose     text not null check (purpose in ('verify','reset')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Idempotência de webhooks Stripe (o Stripe reentrega o mesmo evento).
create table if not exists processed_stripe_events (
  event_id     text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

-- Guard de defesa-em-profundidade: colunas de billing só mudam quando a transação
-- seta o GUC app.billing='on' (só o webhook do Stripe faz isso). Bloqueia qualquer
-- bug noutra rota que tente virar o plano fora do fluxo Stripe.
create or replace function guard_billing_columns()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.billing', true), 'off') <> 'on' then
    if new.plan                   is distinct from old.plan
    or new.stripe_customer_id     is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.current_period_end     is distinct from old.current_period_end then
      raise exception 'Colunas de billing so mudam via webhook Stripe (app.billing!=on)'
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
