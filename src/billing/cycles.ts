// src/billing/cycles.ts — helpers de período e de billing_cycles (trilho manual Pix/boleto).
import { pool } from '../db';

export function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
export function epochSec(d: Date): number { return Math.floor(d.getTime() / 1000); }
export function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x;
}

// Início do próximo período: encadeia a partir do fim do período atual se ainda vigente
// (pagamento adiantado estende), senão começa agora.
export function nextPeriodStart(currentPeriodEnd: Date | null, now: Date): Date {
  if (currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()) return currentPeriodEnd;
  return now;
}

export async function getCurrentPeriodEnd(userId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ current_period_end: Date | null }>(
    'select current_period_end from profiles where id = $1', [userId],
  );
  return rows[0]?.current_period_end ?? null;
}

// Marca/insere um ciclo como PAID, idempotente pelo asaas_payment_id (o job cria PENDING com o
// mesmo id; o webhook do pagamento o vira PAID). Para a 1ª cobrança (checkout) cria direto PAID.
export async function upsertPaidCycle(c: {
  userId: string; plan: string; billingType: 'PIX' | 'BOLETO'; paymentId: string;
  value: number; dueDate: string | null; periodStart: string; periodEnd: string; invoiceUrl: string | null;
}): Promise<void> {
  await pool.query(
    `insert into billing_cycles
       (user_id, plan, billing_type, asaas_payment_id, value, due_date, period_start, period_end, status, invoice_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'PAID',$9)
     on conflict (asaas_payment_id) do update
       set status = 'PAID', period_end = excluded.period_end, updated_at = now()`,
    [c.userId, c.plan, c.billingType, c.paymentId, c.value, c.dueDate, c.periodStart, c.periodEnd, c.invoiceUrl],
  );
}
