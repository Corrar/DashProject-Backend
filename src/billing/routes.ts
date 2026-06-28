import express, { type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
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
  const url = method === 'pix' ? await createPixCheckout(userId, plan) : await createCardCheckout(userId, plan);
  res.json({ url });
}));

// POST /billing/cancel — cancela a assinatura no Asaas (downgrade vem pelo webhook).
router.post('/cancel', requireAuth, requirePlan('essencial'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  await cancelSubscription(req.user!.id);
  res.json({ ok: true });
}));

export default router;
