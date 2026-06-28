import express, { type Request, type Response, type Router } from 'express';
import { pool } from '../db';
import { env } from '../env';
import { log } from '../lib';
import { setPlan, userIdForCustomer, userIdForSubscription, type BillingMethod } from './asaas';
import { planForValue, type PlanId } from '../plans';
import { addDays, epochSec, getCurrentPeriodEnd, nextPeriodStart, upsertPaidCycle, ymd } from './cycles';

// Asaas NÃO assina o corpo (sem HMAC): autenticação por token no header `asaas-access-token`.
// Idempotência por `id` (evt_...) do evento em processed_webhook_events.

interface AsaasPayment {
  id?: string;
  customer?: string;
  subscription?: string | null;
  value?: number;
  billingType?: string;
  externalReference?: string | null;
}
interface AsaasSubscription { id?: string; customer?: string; externalReference?: string | null }
interface AsaasWebhookEvent {
  id?: string;
  event?: string;
  payment?: AsaasPayment;
  subscription?: AsaasSubscription;
}

const ACTIVATE = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// SÓ cancelamento/inativação de assinatura (cartão) derruba na hora. PIX/boleto vencido NÃO
// derruba aqui — fica a cargo do job (regra de período + grace). PAYMENT_OVERDUE só marca o ciclo.
const SUB_END = new Set(['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']);

function methodOf(billingType: string | undefined): BillingMethod {
  if (billingType === 'CREDIT_CARD') return 'card';
  if (billingType === 'BOLETO') return 'boleto';
  return 'pix';
}

export function webhookRouter(): Router {
  const r = express.Router();
  r.post('/webhook', express.json({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response): Promise<void> => {
    const token = req.headers['asaas-access-token'];
    if (!env.asaasWebhookToken || token !== env.asaasWebhookToken) {
      log('warn', 'asaas_webhook_token_invalido', {});
      res.status(401).send('token invalido'); return;
    }

    const evt = req.body as AsaasWebhookEvent;
    const eventId = evt.id;
    const type = evt.event;
    if (!eventId || !type) { res.status(400).send('payload invalido'); return; }

    const dedup = await pool.query(
      'insert into processed_webhook_events (event_id, type) values ($1,$2) on conflict (event_id) do nothing',
      [eventId, type],
    );
    if (dedup.rowCount === 0) { res.json({ received: true, duplicate: true }); return; }

    try {
      await handleEvent(evt);
      res.json({ received: true });
    } catch (e) {
      log('error', 'asaas_webhook_falha', { type, err: String(e) });
      await pool.query('delete from processed_webhook_events where event_id = $1', [eventId]).catch(() => {});
      res.status(500).json({ error: 'falha_processamento' });
    }
  });
  return r;
}

async function resolveUserId(evt: AsaasWebhookEvent): Promise<string | null> {
  const ext = evt.payment?.externalReference ?? evt.subscription?.externalReference ?? null;
  if (ext) return ext;
  const subId = evt.payment?.subscription ?? evt.subscription?.id ?? null;
  if (subId) { const u = await userIdForSubscription(subId); if (u) return u; }
  const custId = evt.payment?.customer ?? evt.subscription?.customer ?? null;
  if (custId) { const u = await userIdForCustomer(custId); if (u) return u; }
  return null;
}

async function handleEvent(evt: AsaasWebhookEvent): Promise<void> {
  const type = evt.event!;
  const userId = await resolveUserId(evt);
  if (!userId) { log('warn', 'asaas_webhook_sem_usuario', { type }); return; }

  // Cancelamento/inativação de assinatura (cartão) -> downgrade imediato.
  if (SUB_END.has(type)) { await setPlan(userId, 'free'); return; }

  // PIX/boleto vencido: NÃO derruba; só marca o ciclo OVERDUE (downgrade fica com o job).
  if (type === 'PAYMENT_OVERDUE') {
    const payId = evt.payment?.id;
    if (payId) {
      await pool.query(
        "update billing_cycles set status='OVERDUE' where asaas_payment_id=$1 and status<>'PAID'", [payId],
      );
    }
    return;
  }

  if (!ACTIVATE.has(type)) return; // ignora ruído (idempotência já registrou)

  const p = evt.payment;
  const value = p?.value;
  const plan: PlanId = (value != null ? planForValue(value) : null) ?? 'essencial';
  const method = methodOf(p?.billingType);
  const customerId = p?.customer ?? null;
  const now = new Date();

  if (p?.subscription) {
    // TRILHO CARTÃO: estende o período (+30d) e mantém assinatura como fonte da verdade.
    const start = nextPeriodStart(await getCurrentPeriodEnd(userId), now);
    const periodEnd = addDays(start, 30);
    await setPlan(userId, plan, { customerId, subId: p.subscription, billingMethod: 'card', periodEnd: epochSec(periodEnd) });
    return;
  }

  // TRILHO MANUAL (pix/boleto): registra ciclo PAID e estende o período.
  const start = nextPeriodStart(await getCurrentPeriodEnd(userId), now);
  const periodEnd = addDays(start, 30);
  const billingType: 'PIX' | 'BOLETO' = method === 'boleto' ? 'BOLETO' : 'PIX';
  if (p?.id) {
    await upsertPaidCycle({
      userId, plan, billingType, paymentId: p.id, value: value ?? 0,
      dueDate: ymd(now), periodStart: ymd(start), periodEnd: ymd(periodEnd), invoiceUrl: null,
    });
  }
  await setPlan(userId, plan, { customerId, billingMethod: method, periodEnd: epochSec(periodEnd) });
}
