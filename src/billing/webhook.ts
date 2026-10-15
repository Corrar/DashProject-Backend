import express, { type Request, type Response, type Router } from 'express';
import { pool } from '../db';
import { env } from '../env';
import { log } from '../lib';
import { setPlan, userIdForCustomer, userIdForSubscription, checkoutSessionFor, type BillingMethod, type CheckoutSession } from './asaas';
import { planForValue, type PlanId } from '../plans';
import { addDays, epochSec, getCurrentPeriodEnd, nextPeriodStart, upsertPaidCycle, ymd } from './cycles';

// Asaas NÃO assina o corpo (sem HMAC): autenticação por token no header `asaas-access-token`.
// Idempotência por `id` (evt_...) do evento em processed_webhook_events.

interface AsaasPayment {
  id?: string;
  customer?: string;
  subscription?: string | null;
  checkoutSession?: string | null;
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

// Ordem: externalReference → subscription (profiles) → customer (profiles) → checkoutSession
// (mapa checkout_sessions). O Checkout hospedado NÃO devolve externalReference no pagamento, então
// a sessão de checkout é a chave confiável da 1ª cobrança.
async function resolveUserId(evt: AsaasWebhookEvent, session: CheckoutSession | null): Promise<string | null> {
  const ext = evt.payment?.externalReference ?? evt.subscription?.externalReference ?? null;
  if (ext) return ext;
  const subId = evt.payment?.subscription ?? evt.subscription?.id ?? null;
  if (subId) { const u = await userIdForSubscription(subId); if (u) return u; }
  const custId = evt.payment?.customer ?? evt.subscription?.customer ?? null;
  if (custId) { const u = await userIdForCustomer(custId); if (u) return u; }
  if (session) return session.userId;
  return null;
}

async function handleEvent(evt: AsaasWebhookEvent): Promise<void> {
  const type = evt.event!;
  const p = evt.payment;
  // Sessão de checkout (se o pagamento veio de um checkout hospedado): dá o vínculo e o tier exato.
  const session = p?.checkoutSession ? await checkoutSessionFor(p.checkoutSession) : null;
  const userId = await resolveUserId(evt, session);
  if (!userId) { log('warn', 'asaas_webhook_sem_usuario', { type }); return; }

  // Cancelamento/inativação de assinatura (cartão) -> downgrade imediato — mas só se for a
  // assinatura VIGENTE do perfil. Evento atrasado de uma assinatura antiga (ex.: cancelou, assinou
  // de novo e só então chegou o INACTIVATED da anterior) não pode derrubar o plano atual.
  if (SUB_END.has(type)) {
    const endedSub = evt.subscription?.id ?? p?.subscription ?? null;
    const cur = await pool.query<{ asaas_subscription_id: string | null }>(
      'select asaas_subscription_id from profiles where id = $1', [userId],
    );
    const currentSub = cur.rows[0]?.asaas_subscription_id ?? null;
    if (endedSub && currentSub && endedSub !== currentSub) {
      log('info', 'asaas_sub_end_ignorado_assinatura_antiga', { type, endedSub });
      return;
    }
    await setPlan(userId, 'free');
    return;
  }

  // PIX/boleto vencido: NÃO derruba; só marca o ciclo OVERDUE (downgrade fica com o job).
  if (type === 'PAYMENT_OVERDUE') {
    const payId = p?.id;
    if (payId) {
      await pool.query(
        "update billing_cycles set status='OVERDUE' where asaas_payment_id=$1 and status<>'PAID'", [payId],
      );
    }
    return;
  }

  if (!ACTIVATE.has(type)) return; // ignora ruído (idempotência já registrou)

  // Idempotência POR PAGAMENTO (a do topo é por evento): no cartão o Asaas manda
  // PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED para a MESMA cobrança — sem esta trava cada
  // pagamento estendia o período duas vezes (+60 dias). A marca só é gravada depois do setPlan,
  // então uma falha no meio continua reprocessável pela reentrega do Asaas.
  const paymentKey = p?.id ? `payment:${p.id}` : null;
  if (paymentKey) {
    const seen = await pool.query('select 1 from processed_webhook_events where event_id = $1', [paymentKey]);
    if ((seen.rowCount ?? 0) > 0) return;
  }

  const value = p?.value;
  // Tier pelo VALOR pago (reflete troca de plano na assinatura: as renovações podem continuar
  // ligadas à sessão do checkout original); senão a sessão de checkout; fallback no menor pago.
  const plan: PlanId = (value != null ? planForValue(value) : null) ?? session?.plan ?? 'essencial';
  const method = methodOf(p?.billingType);
  const customerId = p?.customer ?? null; // gravado via setPlan => próximos eventos resolvem por customer
  const now = new Date();

  if (p?.subscription) {
    // TRILHO CARTÃO: estende o período (+30d) e mantém assinatura como fonte da verdade.
    const start = nextPeriodStart(await getCurrentPeriodEnd(userId), now);
    const periodEnd = addDays(start, 30);
    await setPlan(userId, plan, { customerId, subId: p.subscription, billingMethod: 'card', periodEnd: epochSec(periodEnd) });
    await markPaymentActivated(paymentKey, type);
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
  await markPaymentActivated(paymentKey, type);
}

// Reaproveita processed_webhook_events com chave sintética `payment:<id>` (ids de evento do
// Asaas são `evt_...`, então não colidem).
async function markPaymentActivated(paymentKey: string | null, type: string): Promise<void> {
  if (!paymentKey) return;
  await pool.query(
    'insert into processed_webhook_events (event_id, type) values ($1,$2) on conflict (event_id) do nothing',
    [paymentKey, type],
  );
}
