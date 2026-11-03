// src/plans.ts — ÚNICA fonte da verdade de planos, limites, flags e preços.
// Limites de UX, gate server-side e valores de cobrança Asaas derivam TODOS daqui.
// Nada de limites em env: mudar um plano = mudar este arquivo.

// free.aiMonthly = 1: uma análise de IA por mês para o Free provar o valor da IA (a quota é
// contada em ai_usage, como nos pagos). Precisa de conta: /tools/analyze exige login.
// asaasValueYearly = 10× o mensal ("2 meses grátis").
export const PLANS = {
  free:      { rank: 0, aiMonthly: 1,   maxRows: 5000,    canExport: false, shareLinks: false, removeBranding: false, asaasValue: 0,     asaasValueYearly: 0 },
  essencial: { rank: 1, aiMonthly: 50,  maxRows: 100000,  canExport: true,  shareLinks: false, removeBranding: false, asaasValue: 29.90, asaasValueYearly: 299.00 },
  pro:       { rank: 2, aiMonthly: 300, maxRows: 1000000, canExport: true,  shareLinks: true,  removeBranding: true,  asaasValue: 49.90, asaasValueYearly: 499.00 },
} as const;

export type PlanId = keyof typeof PLANS;
export type PlanDef = (typeof PLANS)[PlanId];
export type PaidPlanId = 'essencial' | 'pro';
export type Cycle = 'monthly' | 'yearly';

// Duração de cada ciclo pago (extensão do período no pagamento e geração das renovações).
export const CYCLE_DAYS: Record<Cycle, number> = { monthly: 30, yearly: 365 };

// Planos pagos (têm cobrança no Asaas), em ordem de rank.
export const PAID_PLANS: readonly PaidPlanId[] = ['essencial', 'pro'];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v);
}

export function isPaidPlan(v: unknown): v is PaidPlanId {
  return v === 'essencial' || v === 'pro';
}

export function isCycle(v: unknown): v is Cycle {
  return v === 'monthly' || v === 'yearly';
}

export function priceFor(plan: PaidPlanId, cycle: Cycle): number {
  return cycle === 'yearly' ? PLANS[plan].asaasValueYearly : PLANS[plan].asaasValue;
}

// Compara níveis: true se `have` libera o que `min` exige.
export function planAllows(have: PlanId, min: PlanId): boolean {
  return PLANS[have].rank >= PLANS[min].rank;
}

// Descobre plano e ciclo a partir do valor cobrado (o webhook do Asaas devolve o `value` da
// cobrança). Tolerância a centavos de arredondamento.
export function chargeForValue(value: number): { plan: PaidPlanId; cycle: Cycle } | null {
  for (const id of PAID_PLANS) {
    if (Math.abs(PLANS[id].asaasValue - value) < 0.01) return { plan: id, cycle: 'monthly' };
    if (Math.abs(PLANS[id].asaasValueYearly - value) < 0.01) return { plan: id, cycle: 'yearly' };
  }
  return null;
}
