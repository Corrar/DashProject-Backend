import express, { type Request, type Response, type Router } from 'express';
import type Stripe from 'stripe';
import { pool } from '../db';
import { env } from '../env';
import { log } from '../lib';
import { stripe, setPlan, userIdForCustomer } from './client';

const ACTIVE = new Set<string>(['active', 'trialing']);

// current_period_end pode estar no topo (APIs antigas) ou no item (APIs recentes).
function subPeriodEnd(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === 'number') return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return typeof item?.current_period_end === 'number' ? item.current_period_end : null;
}

export function webhookRouter(): Router {
  const r = express.Router();
  // RAW body só nesta rota — a assinatura quebra se o JSON for parseado antes.
  r.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response): Promise<void> => {
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string' || !env.stripeWebhookSecret) {
      res.status(400).send('config/assinatura'); return;
    }

    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(req.body as Buffer, sig, env.stripeWebhookSecret);
    } catch (e) {
      log('warn', 'stripe_assinatura_invalida', { err: String(e) });
      res.status(400).send('assinatura invalida'); return;
    }

    // Idempotência: insert-or-skip.
    const dedup = await pool.query(
      'insert into processed_stripe_events (event_id, type) values ($1,$2) on conflict (event_id) do nothing',
      [event.id, event.type],
    );
    if (dedup.rowCount === 0) { res.json({ received: true, duplicate: true }); return; }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object as Stripe.Checkout.Session;
          const userId = s.client_reference_id ?? s.metadata?.app_user_id ?? null;
          if (userId) {
            await setPlan(userId, 'pro', {
              customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
              subId: typeof s.subscription === 'string' ? s.subscription : s.subscription?.id ?? null,
            });
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
          const userId = sub.metadata?.app_user_id ?? (await userIdForCustomer(customerId));
          if (userId) {
            const plan: 'free' | 'pro' = event.type === 'customer.subscription.deleted'
              ? 'free'
              : (ACTIVE.has(sub.status) ? 'pro' : 'free');
            await setPlan(userId, plan, { customerId, subId: sub.id, periodEnd: subPeriodEnd(sub) });
          }
          break;
        }
        default:
          break;
      }
      res.json({ received: true });
    } catch (e) {
      log('error', 'webhook_falha', { type: event.type, err: String(e) });
      // Não processou de fato => libera reentrega do Stripe.
      await pool.query('delete from processed_stripe_events where event_id = $1', [event.id]).catch(() => {});
      res.status(500).json({ error: 'falha_processamento' });
    }
  });
  return r;
}
