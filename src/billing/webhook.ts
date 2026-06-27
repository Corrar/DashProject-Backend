import express, { type Request, type Response, type Router } from 'express';
import { pool } from '../db';
import { env } from '../env';
import { log } from '../lib';
import { setPlan, userIdForCustomer, userIdForSubscription } from './asaas';
import { planForValue, type PlanId } from '../plans';

// Asaas NÃO assina o corpo (sem HMAC, ao contrário do Stripe): a autenticação é um token
// configurável enviado no header `asaas-access-token` (confirmado na doc). Por isso o corpo
// é parseado como JSON normal — não precisa mais do raw-body-antes-do-json.

interface AsaasPayment {
  id?: string;
  customer?: string;
  subscription?: string | null;
  value?: number;
  externalReference?: string | null;
}
interface AsaasSubscription {
  id?: string;
  customer?: string;
  externalReference?: string | null;
}
interface AsaasWebhookEvent {
  id?: string;       // evt_... — chave de idempotência (Asaas pode reentregar)
  event?: string;
  payment?: AsaasPayment;
  subscription?: AsaasSubscription;
}

// Eventos que ATIVAM o plano pago (pagamento confirmado/recebido).
const ACTIVATE = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// Eventos que DERRUBAM para free (inadimplência, estorno, exclusão, cancelamento).
const DEACTIVATE = new Set([
  'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED',
  'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED',
]);

export function webhookRouter(): Router {
  const r = express.Router();
  r.post('/webhook', express.json({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response): Promise<void> => {
    // Validação: token no header deve bater com o configurado.
    const token = req.headers['asaas-access-token'];
    if (!env.asaasWebhookToken || token !== env.asaasWebhookToken) {
      log('warn', 'asaas_webhook_token_invalido', {});
      res.status(401).send('token invalido'); return;
    }

    const evt = req.body as AsaasWebhookEvent;
    const eventId = evt.id;
    const type = evt.event;
    if (!eventId || !type) { res.status(400).send('payload invalido'); return; }

    // Idempotência: insert-or-skip pelo id do evento.
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
      // Não processou de fato => libera reentrega do Asaas.
      await pool.query('delete from processed_webhook_events where event_id = $1', [eventId]).catch(() => {});
      res.status(500).json({ error: 'falha_processamento' });
    }
  });
  return r;
}

// Resolve nosso usuário a partir do evento: externalReference (que setamos no checkout) tem
// prioridade; senão, tenta por subscription/customer já gravados em profiles.
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
  if (!ACTIVATE.has(type) && !DEACTIVATE.has(type)) return; // ignora ruído (idempotência já registrou)

  const userId = await resolveUserId(evt);
  if (!userId) { log('warn', 'asaas_webhook_sem_usuario', { type }); return; }

  if (ACTIVATE.has(type)) {
    // Descobre o tier pelo valor da cobrança; fallback no menor pago.
    const value = evt.payment?.value;
    const matched = value != null ? planForValue(value) : null;
    const plan: PlanId = matched ?? 'essencial';
    await setPlan(userId, plan, {
      customerId: evt.payment?.customer ?? null,
      subId: evt.payment?.subscription ?? null,
    });
    return;
  }
  // DEACTIVATE
  await setPlan(userId, 'free', {});
}
