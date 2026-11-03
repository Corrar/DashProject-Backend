import type { Request, Response, NextFunction } from 'express';
import { log } from './lib';

// Limite de tentativas em memória (janela fixa). O Render roda uma instância só,
// então memória basta; com mais instâncias, trocar por Redis/Postgres.
// Protege login, cadastro e e-mails contra força bruta e abuso de envio.
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

// Limpeza periódica para o Map não crescer sem fim.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

export function rateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string | null;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const part = opts.key ? opts.key(req) : null;
    const k = `${opts.name}:${req.ip}:${part ?? ''}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + opts.windowMs }; buckets.set(k, b); }
    b.count++;
    if (b.count > opts.max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log('warn', 'rate_limit', { name: opts.name, ip: req.ip });
      res.status(429).json({ error: 'muitas_tentativas', retryAfter });
      return;
    }
    next();
  };
}

// Só para testes.
export function resetRateLimits(): void { buckets.clear(); }
