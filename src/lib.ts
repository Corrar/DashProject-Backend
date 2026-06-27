import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';

type Level = 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

// Envolve handlers async e encaminha rejeições ao error handler.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => { fn(req, res, next).catch(next); };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'payload_invalido', issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  log('error', 'erro_nao_tratado', { err: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({ error: 'erro_interno' });
}
