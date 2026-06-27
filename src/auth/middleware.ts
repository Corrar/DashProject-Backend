import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from './tokens';
import { pool } from '../db';
import { HttpError, asyncHandler } from '../lib';

export interface AuthedRequest extends Request {
  user?: { id: string; email: string; plan: 'free' | 'pro' };
}

// Cache curto do plano: o webhook é a fonte da verdade e muda raramente.
const TTL = 30_000;
const planCache = new Map<string, { plan: 'free' | 'pro'; exp: number }>();

export function invalidatePlan(userId: string): void { planCache.delete(userId); }

async function planOf(userId: string): Promise<'free' | 'pro'> {
  const hit = planCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.plan;
  const { rows } = await pool.query<{ plan: 'free' | 'pro' }>(
    'select plan from profiles where id = $1', [userId],
  );
  const plan: 'free' | 'pro' = rows[0]?.plan === 'pro' ? 'pro' : 'free';
  planCache.set(userId, { plan, exp: Date.now() + TTL });
  return plan;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t.length > 0 ? t : null;
}

// Exige sessão válida e popula req.user com o plano REAL do banco (não o do token).
export const requireAuth = asyncHandler(async (req: AuthedRequest, _res, next) => {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'token_ausente');
  const claims = verifyAccessToken(token);
  req.user = { id: claims.sub, email: claims.email, plan: await planOf(claims.sub) };
  next();
});

// Gate de plano: usar nas rotas das ferramentas pagas.
export function requirePlan(min: 'pro') {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new HttpError(401, 'nao_autenticado');
    if (req.user.plan !== min) throw new HttpError(402, 'plano_insuficiente');
    next();
  };
}
