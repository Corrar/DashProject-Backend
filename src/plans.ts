// src/plans.ts — ÚNICA fonte da verdade de planos, limites e flags.
// Limites de UX, gate server-side e valores de cobrança Asaas derivam TODOS daqui.
// Nada de limites em env: mudar um plano = mudar este arquivo.

export const PLANS = {
  free:      { rank: 0, aiMonthly: 3,   maxRows: 5000,    canExport: false, shareLinks: false, removeBranding: false, asaasValue: 0 },
  essencial: { rank: 1, aiMonthly: 50,  maxRows: 100000,  canExport: true,  shareLinks: false, removeBranding: false, asaasValue: 29.90 },
  pro:       { rank: 2, aiMonthly: 300, maxRows: 1000000, canExport: true,  shareLinks: true,  removeBranding: true,  asaasValue: 49.90 },
} as const;

export type PlanId = keyof typeof PLANS;
export type PlanDef = (typeof PLANS)[PlanId];

// Planos pagos (têm cobrança no Asaas), em ordem de rank.
export const PAID_PLANS: readonly ('essencial' | 'pro')[] = ['essencial', 'pro'];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v);
}

export function isPaidPlan(v: unknown): v is 'essencial' | 'pro' {
  return v === 'essencial' || v === 'pro';
}

// Compara níveis: true se `have` libera o que `min` exige.
export function planAllows(have: PlanId, min: PlanId): boolean {
  return PLANS[have].rank >= PLANS[min].rank;
}

// Descobre o plano pago a partir do valor cobrado (usado no webhook do Asaas,
// que devolve o `value` da cobrança). Tolerância a centavos de arredondamento.
export function planForValue(value: number): 'essencial' | 'pro' | null {
  for (const id of PAID_PLANS) {
    if (Math.abs(PLANS[id].asaasValue - value) < 0.01) return id;
  }
  return null;
}
