import Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { env } from '../env';
import { HttpError } from '../lib';
import { invalidatePlan } from '../auth/middleware';

let _stripe: Stripe | null = null;
export function stripe(): Stripe {
  if (!env.stripeSecret) throw new HttpError(503, 'stripe_nao_configurado');
  if (!_stripe) _stripe = new Stripe(env.stripeSecret);
  return _stripe;
}

// Atualiza o plano DENTRO de uma transação com app.billing='on' (libera o trigger guard).
// É o ÚNICO caminho que escreve colunas de billing.
export async function setPlan(
  userId: string,
  plan: 'free' | 'pro',
  patch: { customerId?: string | null; subId?: string | null; periodEnd?: number | null },
): Promise<void> {
  const c: PoolClient = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.billing','on', true)"); // local à transação
    await c.query(
      `update profiles set
         plan = $2,
         stripe_customer_id = coalesce($3, stripe_customer_id),
         stripe_subscription_id = coalesce($4, stripe_subscription_id),
         current_period_end = case when $5::bigint is null then current_period_end
                                   else to_timestamp($5::bigint) end
       where id = $1`,
      [userId, plan, patch.customerId ?? null, patch.subId ?? null, patch.periodEnd ?? null],
    );
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  invalidatePlan(userId);
}

export async function userIdForCustomer(customerId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from profiles where stripe_customer_id = $1', [customerId],
  );
  return rows[0]?.id ?? null;
}
