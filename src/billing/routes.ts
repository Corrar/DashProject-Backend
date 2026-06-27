import express, { type Response } from 'express';
import { env } from '../env';
import { HttpError, asyncHandler } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
import { stripe } from './client';
import { pool } from '../db';

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

// POST /billing/checkout — qualquer logado inicia o upgrade.
router.post('/checkout', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (!env.stripePricePro) throw new HttpError(503, 'price_nao_configurado');
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: env.stripePricePro, quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    subscription_data: {
      metadata: { app_user_id: user.id },
      ...(env.trialDays > 0 ? { trial_period_days: env.trialDays } : {}),
    },
    allow_promotion_codes: true,
    success_url: `${env.appUrl}/?upgrade=ok`,
    cancel_url: `${env.appUrl}/?upgrade=cancel`,
  });
  res.json({ url: session.url });
}));

// POST /billing/portal — gerenciar/cancelar (só Pro tem customer).
router.post('/portal', requireAuth, requirePlan('pro'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { rows } = await pool.query<{ stripe_customer_id: string | null }>(
    'select stripe_customer_id from profiles where id = $1', [user.id],
  );
  const customer = rows[0]?.stripe_customer_id;
  if (!customer) throw new HttpError(409, 'sem_customer_stripe');
  const portal = await stripe().billingPortal.sessions.create({
    customer,
    return_url: `${env.appUrl}/?from=portal`,
  });
  res.json({ url: portal.url });
}));

export default router;
