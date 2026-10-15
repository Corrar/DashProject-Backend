import express, { type Response } from 'express';
import { z } from 'zod';
import { HttpError, asyncHandler } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
import { pool } from '../db';
import { planAllows } from '../plans';
import { createCardCheckout, createPixCheckout, cancelSubscription } from './asaas';

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

// method 'card' = recorrente no cartão; 'pix' = entrada avulsa por Pix (boleto fica nas renovações).
const checkoutSchema = z.object({
  plan: z.enum(['essencial', 'pro']),
  method: z.enum(['card', 'pix']).default('card'),
});

// POST /billing/checkout — qualquer logado inicia o upgrade. Responde { url } (Checkout Asaas).
router.post('/checkout', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { plan, method } = checkoutSchema.parse(req.body);
  const userId = req.user!.id;
  // Comprar o mesmo tier (ou um inferior) só gera uma cobrança duplicada: o plano atual já cobre.
  if (planAllows(req.user!.plan, plan)) {
    throw new HttpError(409, 'plano_ja_ativo', 'Seu plano atual já inclui este plano.');
  }
  // Assinatura recorrente no cartão ativa: um 2º checkout criaria OUTRA assinatura no Asaas e as
  // duas seguiriam cobrando (e as faturas da antiga voltariam o plano para o tier antigo via
  // webhook). Até existir troca de plano na própria assinatura, pede o cancelamento antes.
  const { rows } = await pool.query<{ billing_method: string | null; asaas_subscription_id: string | null }>(
    'select billing_method, asaas_subscription_id from profiles where id = $1', [userId],
  );
  if (req.user!.plan !== 'free' && rows[0]?.billing_method === 'card' && rows[0]?.asaas_subscription_id) {
    throw new HttpError(409, 'assinatura_ativa', 'Cancele a assinatura atual antes de trocar de plano.');
  }
  const url = method === 'pix' ? await createPixCheckout(userId, plan) : await createCardCheckout(userId, plan);
  res.json({ url });
}));

// POST /billing/cancel — cancela a assinatura no Asaas (downgrade vem pelo webhook).
router.post('/cancel', requireAuth, requirePlan('essencial'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  await cancelSubscription(req.user!.id);
  res.json({ ok: true });
}));

export default router;
