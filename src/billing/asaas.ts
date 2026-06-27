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

// ── Escrita de plano: ÚNICO caminho que toca plan/asaas_* (GUC libera o trigger guard) ──
export async function setPlan(
  userId: string,
  plan: PlanId,
  patch: { customerId?: string | null; subId?: string | null } = {},
): Promise<void> {
  const c: PoolClient = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.billing','on', true)"); // local à transação
    await c.query(
      `update profiles set
         plan = $2,
         asaas_customer_id     = coalesce($3, asaas_customer_id),
         asaas_subscription_id = coalesce($4, asaas_subscription_id)
       where id = $1`,
      [userId, plan, patch.customerId ?? null, patch.subId ?? null],
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

// Cria um Checkout HOSPEDADO recorrente mensal e devolve a URL para redirecionar.
//
// Regras confirmadas no sandbox Asaas:
//  - chargeTypes RECURRENT só aceita billingTypes ['CREDIT_CARD'] (PIX exige chave Pix + DETACHED;
//    boleto não é permitido em recorrência). Assinatura mensal => cartão.
//  - NÃO enviamos customerData: a própria página do Asaas coleta nome/CPF/telefone/endereço do
//    pagador (se enviássemos customerData parcial, TODOS esses campos virariam obrigatórios aqui).
//    Por isso o frontend NÃO precisa coletar CPF.
//  - callback exige URLs HTTPS públicas (localhost é rejeitado) — em produção APP_URL é https.
//  - externalReference = user.id propaga para a assinatura e os pagamentos => volta no webhook.
export async function createCheckout(userId: string, plan: 'essencial' | 'pro'): Promise<string> {
  const value = PLANS[plan].asaasValue;
  const resp = await asaasFetch<CheckoutResponse>('/checkouts', {
    method: 'POST',
    body: {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      minutesToExpire: 60,
      externalReference: userId,
      callback: {
        successUrl: `${env.appUrl}/?upgrade=ok`,
        cancelUrl: `${env.appUrl}/?upgrade=cancel`,
        expiredUrl: `${env.appUrl}/?upgrade=expired`,
      },
      items: [{ name: `Dash ${plan}`, description: `Plano ${plan} (mensal)`, quantity: 1, value }],
      subscription: { cycle: 'MONTHLY', nextDueDate: todayISO() },
    },
  });
  const url = resp.link ?? resp.url;
  if (!url) throw new HttpError(502, 'asaas_sem_url', 'checkout criado sem URL hospedada');
  return url;
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
