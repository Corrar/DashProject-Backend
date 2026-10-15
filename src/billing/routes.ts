import express, { type Response } from 'express';
import { z } from 'zod';
import { HttpError, asyncHandler, log } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
import { pool } from '../db';
import { PLANS } from '../plans';
import { createCardCheckout, createPixCheckout, cancelSubscription, setPlan, updateSubscriptionPlan, listCustomerPayments } from './asaas';

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

// method 'card' = recorrente no cartão; 'pix' = entrada avulsa por Pix (boleto fica nas renovações).
// cycle 'yearly' = plano anual (10× o mensal).
const checkoutSchema = z.object({
  plan: z.enum(['essencial', 'pro']),
  method: z.enum(['card', 'pix']).default('card'),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
});

interface BillingRow {
  billing_method: string | null; asaas_subscription_id: string | null;
  billing_cycle: string | null; auto_renew: boolean | null; current_period_end: Date | null;
}
async function billingOf(userId: string): Promise<BillingRow | undefined> {
  const { rows } = await pool.query<BillingRow>(
    'select billing_method, asaas_subscription_id, billing_cycle, auto_renew, current_period_end from profiles where id = $1',
    [userId],
  );
  return rows[0];
}

// POST /billing/checkout — inicia uma assinatura. Responde { url } (Checkout Asaas).
router.post('/checkout', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { plan, method, cycle } = checkoutSchema.parse(req.body);
  const user = req.user!;
  const cur = await billingOf(user.id);
  // Quem cancelou o cartão e ainda está no período pago (auto_renew=false) pode reassinar à vontade.
  const renewing = user.plan !== 'free' && cur?.auto_renew !== false;
  if (renewing) {
    // Tier inferior ou o mesmo plano no mesmo ciclo: o plano atual já cobre (seria cobrança em dobro).
    if (PLANS[plan].rank < PLANS[user.plan].rank || (plan === user.plan && cycle === (cur?.billing_cycle ?? 'monthly'))) {
      throw new HttpError(409, 'plano_ja_ativo', 'Seu plano atual já inclui este plano.');
    }
    // Assinatura recorrente no cartão: um 2º checkout criaria OUTRA assinatura no Asaas e as duas
    // cobrariam. A troca é na própria assinatura (POST /billing/change-plan).
    if (cur?.billing_method === 'card' && cur?.asaas_subscription_id) {
      throw new HttpError(409, 'assinatura_ativa', 'Use a troca de plano da assinatura atual (POST /billing/change-plan).');
    }
  }
  const url = method === 'pix' ? await createPixCheckout(user.id, plan, cycle) : await createCardCheckout(user.id, plan, cycle);
  res.json({ url });
}));

// POST /billing/change-plan — troca de tier na assinatura do cartão, sem 2ª assinatura.
// Upgrade: libera na hora (a diferença deste mês não é cobrada; o próximo ciclo já vem no
// valor novo). Downgrade: vale no próximo ciclo — o webhook do pagamento com o valor menor
// ajusta o plano (chargeForValue). Pix não tem assinatura: troca é um novo checkout Pix.
// Também troca o ciclo (mensal ↔ anual): vale na próxima cobrança, que já vem no valor do ciclo novo.
const changePlanSchema = z.object({
  plan: z.enum(['essencial', 'pro']),
  cycle: z.enum(['monthly', 'yearly']).optional(),
});
router.post('/change-plan', requireAuth, requirePlan('essencial'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = changePlanSchema.parse(req.body);
  const user = req.user!;
  const cur = await billingOf(user.id);
  const curCycle = cur?.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  const cycle = body.cycle ?? curCycle;
  if (user.plan === body.plan && cycle === curCycle) throw new HttpError(409, 'plano_ja_ativo', 'Você já está neste plano.');
  const subId = cur?.asaas_subscription_id;
  if (cur?.billing_method !== 'card' || !subId) {
    throw new HttpError(409, 'sem_assinatura_cartao', 'A troca automática é só para assinatura no cartão.');
  }
  if (cur.auto_renew === false) {
    throw new HttpError(409, 'assinatura_cancelada', 'A assinatura foi cancelada. Assine de novo para trocar de plano.');
  }
  await updateSubscriptionPlan(subId, body.plan, cycle);
  const upgrade = PLANS[body.plan].rank > PLANS[user.plan].rank;
  // billing_cycle acompanha o ciclo configurado na assinatura (o da próxima cobrança), senão quem
  // trocou anual → mensal não conseguiria desfazer (o banco ainda diria "anual"). O acesso já pago
  // segue em current_period_end; o tier menor só vale quando o webhook receber o valor novo.
  await setPlan(user.id, upgrade ? body.plan : user.plan, { cycle });
  res.json({ ok: true, plan: upgrade ? body.plan : user.plan, cycle, effective: upgrade ? 'now' : 'next_cycle' });
}));

// POST /billing/cancel — cancela a assinatura no Asaas. A renovação para e o acesso continua até o
// fim do período já pago (o webhook marca auto_renew=false; o job derruba para Free depois).
router.post('/cancel', requireAuth, requirePlan('essencial'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  await cancelSubscription(req.user!.id);
  const cur = await billingOf(req.user!.id);
  res.json({ ok: true, accessUntil: cur?.current_period_end ?? null });
}));

// GET /billing/history — faturas reais do cliente no Asaas (cartão e Pix), com
// link da fatura. Se o Asaas estiver fora, cai nos ciclos Pix/boleto locais.
router.get('/history', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { rows } = await pool.query<{ asaas_customer_id: string | null }>(
    'select asaas_customer_id from profiles where id = $1', [req.user!.id],
  );
  const customer = rows[0]?.asaas_customer_id ?? null;
  const local = async () => (await pool.query<{
    asaas_payment_id: string | null; value: string; status: string; billing_type: string; due_date: Date | null;
    invoice_url: string | null; plan: string; created_at: Date;
  }>(
    `select asaas_payment_id, value, status, billing_type, due_date, invoice_url, plan, created_at
       from billing_cycles where user_id = $1 order by created_at desc limit 24`, [req.user!.id],
  )).rows.map((c) => ({
    id: c.asaas_payment_id ?? null, value: Number(c.value), status: c.status, method: c.billing_type,
    description: `Plano ${c.plan}`, dueDate: c.due_date, paidAt: null, invoiceUrl: c.invoice_url,
  }));
  if (!customer) { res.json({ source: 'local', items: await local() }); return; }
  try {
    const items = (await listCustomerPayments(customer)).map((p) => ({
      id: p.id, value: Number(p.value), status: p.status, method: p.billingType ?? null,
      description: p.description ?? null, dueDate: p.dueDate ?? null,
      paidAt: p.clientPaymentDate ?? p.paymentDate ?? null, invoiceUrl: p.invoiceUrl ?? null,
    }));
    res.json({ source: 'asaas', items });
  } catch (e) {
    log('warn', 'historico_asaas_indisponivel', { motivo: e instanceof Error ? e.message : String(e) });
    res.json({ source: 'local', items: await local() });
  }
}));

export default router;
