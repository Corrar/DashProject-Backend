// src/jobs/routes.ts — POST /jobs/billing-tick (cron externo, idempotente).
// Trilho MANUAL (pix/boleto) apenas. O trilho cartão é gerido pelos webhooks do Asaas.
import express, { type Request, type Response } from 'express';
import { pool } from '../db';
import { env } from '../env';
import { asyncHandler, log } from '../lib';
import { CYCLE_DAYS, isPlanId, priceFor } from '../plans';
import { createPayment, setPlan } from '../billing/asaas';
import { addDays, ymd } from '../billing/cycles';
import { sendInvoiceEmail, sendInvoiceReminder } from '../auth/email';

const router = express.Router();
router.use(express.json({ limit: '8kb' }));

interface Candidate {
  user_id: string; plan: string; billing_method: 'pix' | 'boleto';
  asaas_customer_id: string; current_period_end: Date; email: string; billing_cycle: string;
}

// A) GERAÇÃO da próxima cobrança (lead days antes do fim), sem duplicar.
async function generate(): Promise<number> {
  const { rows } = await pool.query<Candidate>(
    `select p.id as user_id, p.plan, p.billing_method, p.asaas_customer_id, p.current_period_end, p.billing_cycle, u.email
       from profiles p join users u on u.id = p.id
      where p.billing_method in ('pix','boleto')
        and p.plan <> 'free'
        and p.asaas_customer_id is not null
        and p.current_period_end is not null
        and p.current_period_end <= now() + ($1 || ' days')::interval
        and not exists (
          select 1 from billing_cycles bc
           where bc.user_id = p.id
             and bc.period_start = (p.current_period_end)::date
             and bc.status in ('PENDING','PAID'))`,
    [env.renewalLeadDays],
  );

  let generated = 0;
  for (const c of rows) {
    if (!isPlanId(c.plan) || c.plan === 'free') continue;
    const cycle = c.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    const value = priceFor(c.plan, cycle);
    const billingType: 'PIX' | 'BOLETO' = c.billing_method === 'boleto' ? 'BOLETO' : 'PIX';
    const periodStart = ymd(c.current_period_end);
    const periodEnd = ymd(addDays(c.current_period_end, CYCLE_DAYS[cycle]));
    const dueDate = periodStart;

    const client = await pool.connect();
    try {
      await client.query('begin');
      // Lock do usuário + recheck dentro do lock (evita cobrança duplicada concorrente).
      await client.query('select 1 from profiles where id = $1 for update', [c.user_id]);
      const dup = await client.query(
        "select 1 from billing_cycles where user_id=$1 and period_start=$2 and status in ('PENDING','PAID')",
        [c.user_id, periodStart],
      );
      if ((dup.rowCount ?? 0) > 0) { await client.query('rollback'); continue; }

      const pay = await createPayment({ userId: c.user_id, customerId: c.asaas_customer_id, billingType, value, dueDate, description: `Renovacao Dash ${c.plan} (${cycle === 'yearly' ? 'anual' : 'mensal'})` });
      await client.query(
        `insert into billing_cycles
           (user_id, plan, billing_type, asaas_payment_id, value, due_date, period_start, period_end, status, invoice_url, reminders)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,'{"lead":true}')`,
        [c.user_id, c.plan, billingType, pay.id, value, dueDate, periodStart, periodEnd, pay.invoiceUrl],
      );
      await client.query('commit');
      generated++;
      await sendInvoiceEmail(c.email, pay.invoiceUrl, dueDate, c.plan, value).catch((e) => log('error', 'invoice_email_falha', { err: String(e) }));
    } catch (e) {
      await client.query('rollback').catch(() => {});
      log('error', 'billing_generate_falha', { user: c.user_id, err: String(e) });
    } finally {
      client.release();
    }
  }
  return generated;
}

// B) LEMBRETES nos marcos (D-1, vencimento, atraso), uma vez cada (marca em reminders).
async function reminders(): Promise<number> {
  const { rows } = await pool.query<{
    id: string; due_date: string; plan: string; value: string; invoice_url: string | null;
    reminders: Record<string, boolean>; email: string;
  }>(
    `select bc.id, to_char(bc.due_date,'YYYY-MM-DD') as due_date, bc.plan, bc.value, bc.invoice_url, bc.reminders, u.email
       from billing_cycles bc join users u on u.id = bc.user_id
      where bc.status = 'PENDING'`,
  );
  const todayMs = Date.parse(ymd(new Date()));
  let sent = 0;
  for (const c of rows) {
    if (!c.invoice_url) continue;
    const days = Math.round((Date.parse(c.due_date) - todayMs) / 86_400_000);
    let kind: 'd1' | 'due' | 'overdue' | null = null;
    if (days === 1 && !c.reminders.d1) kind = 'd1';
    else if (days === 0 && !c.reminders.due) kind = 'due';
    else if (days <= -1 && !c.reminders.overdue) kind = 'overdue';
    if (!kind) continue;
    await sendInvoiceReminder(c.email, c.invoice_url, c.due_date, c.plan, Number(c.value), kind)
      .catch((e) => log('error', 'reminder_email_falha', { err: String(e) }));
    await pool.query('update billing_cycles set reminders = reminders || $2::jsonb where id = $1',
      [c.id, JSON.stringify({ [kind]: true })]);
    sent++;
  }
  return sent;
}

// C) EXPIRAÇÃO/DOWNGRADE após o grace: pix/boleto sem pagamento e cartão cancelado
//    (auto_renew=false) cujo período pago acabou. Cartão que renova é gerido pelos webhooks.
async function expire(): Promise<number> {
  const { rows } = await pool.query<{ user_id: string }>(
    `select p.id as user_id from profiles p
      where p.plan <> 'free'
        and p.current_period_end is not null
        and p.current_period_end + ($1 || ' days')::interval < now()
        and (
          (p.billing_method in ('pix','boleto') and not exists (
            select 1 from billing_cycles bc
             where bc.user_id = p.id and bc.status = 'PAID' and bc.period_end > now()::date))
          or (p.billing_method = 'card' and p.auto_renew = false)
        )`,
    [env.graceDays],
  );
  for (const r of rows) {
    await setPlan(r.user_id, 'free');
    await pool.query("update billing_cycles set status='OVERDUE' where user_id=$1 and status='PENDING'", [r.user_id]);
  }
  return rows.length;
}

// D) LIMPEZA (minimização de dados, LGPD): tokens de sessão vencidos ou
//    revogados há mais de 30 dias (guardam IP e navegador), links de e-mail
//    usados/vencidos e IDs de webhook com mais de 90 dias (a idempotência só
//    precisa da janela de reentrega do Asaas).
async function cleanup(): Promise<number> {
  const a = await pool.query(
    "delete from refresh_tokens where coalesce(revoked_at, expires_at) < now() - interval '30 days'",
  );
  const b = await pool.query(
    "delete from email_tokens where coalesce(used_at, expires_at) < now() - interval '30 days'",
  );
  const c = await pool.query(
    "delete from processed_webhook_events where processed_at < now() - interval '90 days'",
  );
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}

router.post('/billing-tick', asyncHandler(async (req: Request, res: Response) => {
  if (!env.jobsSecret || req.headers['x-jobs-secret'] !== env.jobsSecret) {
    res.status(401).json({ error: 'nao_autorizado' });
    return;
  }
  const generated = await generate();
  const remindersSent = await reminders();
  const downgraded = await expire();
  const purged = await cleanup();
  log('info', 'billing_tick', { generated, remindersSent, downgraded, purged });
  res.json({ ok: true, generated, reminders: remindersSent, downgraded, purged });
}));

export default router;
