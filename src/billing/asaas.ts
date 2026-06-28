// src/billing/asaas.ts — cliente Asaas + escrita transacional de plano.
//
// Por que Checkout hospedado (POST /v3/checkouts) e NÃO ensureCustomer+createSubscription:
//   A criação direta de customer no Asaas (POST /v3/customers) EXIGE `cpfCnpj`, que o
//   backend não coleta (o contrato do /billing/checkout é só { plan }). O fluxo hospedado
//   (preferido no brief) deixa o pagador informar o CPF na própria página do Asaas, mantém
//   escopo PCI baixo e habilita PIX/cartão/boleto numa única URL. O vínculo de volta com o
//   usuário é feito por `externalReference = user.id`, propagado para a assinatura/cobrança.
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { env } from '../env';
import { HttpError, log } from '../lib';
import { invalidatePlan } from '../auth/middleware';
import { PLANS, type PlanId } from '../plans';

interface AsaasErrorBody { errors?: { code?: string; description?: string }[] }

async function asaasFetch<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  if (!env.asaasApiKey) throw new HttpError(503, 'asaas_nao_configurado');
  const res = await fetch(`${env.asaasBaseUrl}${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'dash-backend',
      access_token: env.asaasApiKey, // header de auth do Asaas (confirmado na doc)
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const desc = (json as AsaasErrorBody).errors?.[0]?.description ?? text.slice(0, 300);
    log('error', 'asaas_erro', { path, status: res.status, desc });
    throw new HttpError(502, 'asaas_erro', desc);
  }
  return json as T;
}

export type BillingMethod = 'card' | 'pix' | 'boleto';

// ── Escrita de plano: ÚNICO caminho que toca plan/asaas_*/billing_method/current_period_end
//    (o GUC app.billing='on' libera o trigger guard). ──
export async function setPlan(
  userId: string,
  plan: PlanId,
  patch: {
    customerId?: string | null;
    subId?: string | null;
    billingMethod?: BillingMethod | null;
    periodEnd?: number | null; // epoch (segundos); null = mantém
  } = {},
): Promise<void> {
  const c: PoolClient = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.billing','on', true)"); // local à transação
    await c.query(
      `update profiles set
         plan = $2,
         asaas_customer_id     = coalesce($3, asaas_customer_id),
         asaas_subscription_id = coalesce($4, asaas_subscription_id),
         billing_method        = coalesce($5, billing_method),
         current_period_end    = case when $6::bigint is null then current_period_end
                                      else to_timestamp($6::bigint) end
       where id = $1`,
      [userId, plan, patch.customerId ?? null, patch.subId ?? null, patch.billingMethod ?? null, patch.periodEnd ?? null],
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
    'select id from profiles where asaas_customer_id = $1', [customerId],
  );
  return rows[0]?.id ?? null;
}

export async function userIdForSubscription(subId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from profiles where asaas_subscription_id = $1', [subId],
  );
  return rows[0]?.id ?? null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (nextDueDate >= hoje)
}

// Resposta do checkout: a URL hospedada vem no campo `link` (confirmado no sandbox);
// aceitamos `url` como alternativa defensiva.
interface CheckoutResponse { id?: string; link?: string; url?: string; status?: string }

function callbackUrls() {
  return {
    successUrl: `${env.appUrl}/?upgrade=ok`,
    cancelUrl: `${env.appUrl}/?upgrade=cancel`,
    expiredUrl: `${env.appUrl}/?upgrade=expired`,
  };
}

// TRILHO CARTÃO — Checkout HOSPEDADO recorrente mensal (cartão). Confirmado no sandbox:
//  - chargeTypes RECURRENT só aceita billingTypes ['CREDIT_CARD'].
//  - NÃO enviamos customerData (a página do Asaas coleta CPF/endereço) => frontend não coleta CPF.
//  - callback exige URLs HTTPS públicas (localhost é rejeitado).
//  - externalReference = userId propaga p/ assinatura e pagamentos => volta no webhook.
export async function createCardCheckout(userId: string, plan: 'essencial' | 'pro'): Promise<string> {
  const value = PLANS[plan].asaasValue;
  const resp = await asaasFetch<CheckoutResponse>('/checkouts', {
    method: 'POST',
    body: {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      minutesToExpire: 60,
      externalReference: userId,
      callback: callbackUrls(),
      items: [{ name: `Dash ${plan}`, description: `Plano ${plan} (mensal)`, quantity: 1, value }],
      subscription: { cycle: 'MONTHLY', nextDueDate: todayISO() },
    },
  });
  const url = resp.link ?? resp.url;
  if (!url) throw new HttpError(502, 'asaas_sem_url', 'checkout criado sem URL hospedada');
  return url;
}

// TRILHO MANUAL — Checkout HOSPEDADO avulso (Pix) para a 1ª cobrança. Confirmado no sandbox:
//  - chargeTypes DETACHED aceita billingTypes ['PIX'] (BOLETO é REJEITADO no Checkout API;
//    boleto só via POST /payments, usado nas renovações do job).
//  - Sem customerData: a página coleta CPF e CRIA o customer (pegamos o customer id no webhook
//    para gerar os próximos ciclos via POST /payments).
export async function createPixCheckout(userId: string, plan: 'essencial' | 'pro'): Promise<string> {
  const value = PLANS[plan].asaasValue;
  const resp = await asaasFetch<CheckoutResponse>('/checkouts', {
    method: 'POST',
    body: {
      billingTypes: ['PIX'],
      chargeTypes: ['DETACHED'],
      minutesToExpire: 60,
      externalReference: userId,
      callback: callbackUrls(),
      items: [{ name: `Dash ${plan}`, description: `Plano ${plan} (Pix mensal)`, quantity: 1, value }],
    },
  });
  const url = resp.link ?? resp.url;
  if (!url) throw new HttpError(502, 'asaas_sem_url', 'checkout pix sem URL hospedada');
  return url;
}

interface PaymentResponse { id?: string; invoiceUrl?: string; bankSlipUrl?: string; status?: string }

// Gera uma cobrança avulsa (renovação do trilho manual) reusando o customer JÁ existente
// (sem reenviar cpfCnpj). Confirmado no sandbox: invoiceUrl é a URL hospedada (Pix e boleto).
export async function createPayment(opts: {
  userId: string;
  customerId: string;
  billingType: 'PIX' | 'BOLETO';
  value: number;
  dueDate: string; // YYYY-MM-DD
  description?: string;
}): Promise<{ id: string; invoiceUrl: string }> {
  const resp = await asaasFetch<PaymentResponse>('/payments', {
    method: 'POST',
    body: {
      customer: opts.customerId,
      billingType: opts.billingType,
      value: opts.value,
      dueDate: opts.dueDate,
      description: opts.description,
      externalReference: opts.userId,
    },
  });
  if (!resp.id || !resp.invoiceUrl) throw new HttpError(502, 'asaas_payment_sem_url', 'pagamento sem invoiceUrl');
  return { id: resp.id, invoiceUrl: resp.invoiceUrl };
}

// Cancela a assinatura no Asaas. O downgrade p/ 'free' vem pelo webhook (não escrevemos aqui).
export async function cancelSubscription(userId: string): Promise<void> {
  const { rows } = await pool.query<{ asaas_subscription_id: string | null }>(
    'select asaas_subscription_id from profiles where id = $1', [userId],
  );
  const subId = rows[0]?.asaas_subscription_id;
  if (!subId) throw new HttpError(409, 'sem_assinatura_asaas');
  await asaasFetch<{ deleted?: boolean }>(`/subscriptions/${subId}`, { method: 'DELETE' });
}
