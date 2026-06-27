import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../env';
import { pool } from '../db';
import { HttpError } from '../lib';

export interface AccessClaims { sub: string; email: string; plan: 'free' | 'pro'; }

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, env.jwtAccessSecret, { expiresIn: env.accessTtlSec, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const p = jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.email !== 'string') throw new Error('claims');
    return { sub: p.sub, email: p.email, plan: p.plan === 'pro' ? 'pro' : 'free' };
  } catch {
    throw new HttpError(401, 'token_invalido');
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Cria refresh token opaco; guarda só o hash; retorna o valor em claro (vai no cookie).
export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + env.refreshTtlSec * 1000);
  await pool.query(
    'insert into refresh_tokens (user_id, token_hash, expires_at) values ($1,$2,$3)',
    [userId, sha256(raw), expires],
  );
  return raw;
}

// Valida e ROTACIONA: revoga o atual, emite outro. Reuso de token revogado => mata a sessão.
export async function rotateRefreshToken(raw: string): Promise<{ userId: string; newRaw: string }> {
  const hash = sha256(raw);
  const { rows } = await pool.query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
    'select id, user_id, expires_at, revoked_at from refresh_tokens where token_hash = $1',
    [hash],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'refresh_invalido');
  if (row.revoked_at) {
    await pool.query(
      'update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null',
      [row.user_id],
    );
    throw new HttpError(401, 'refresh_reutilizado');
  }
  if (row.expires_at.getTime() < Date.now()) throw new HttpError(401, 'refresh_expirado');
  await pool.query('update refresh_tokens set revoked_at = now() where id = $1', [row.id]);
  const newRaw = await issueRefreshToken(row.user_id);
  return { userId: row.user_id, newRaw };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await pool.query(
    'update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null',
    [sha256(raw)],
  );
}
