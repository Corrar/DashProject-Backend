import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../env';
import { pool } from '../db';
import { HttpError } from '../lib';
import { isPlanId, type PlanId } from '../plans';

// sid = família do refresh token (a "sessão"): identifica a sessão atual na
// tela de sessões e permite encerrar as outras sem derrubar esta.
export interface AccessClaims { sub: string; email: string; plan: PlanId; sid?: string; }

// Dispositivo e IP de quem usa a sessão (tela "Sessões ativas").
export interface SessionCtx { userAgent?: string | null; ip?: string | null }

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, env.jwtAccessSecret, { expiresIn: env.accessTtlSec, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const p = jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.email !== 'string') throw new Error('claims');
    return { sub: p.sub, email: p.email, plan: isPlanId(p.plan) ? p.plan : 'free', sid: typeof p.sid === 'string' ? p.sid : undefined };
  } catch {
    throw new HttpError(401, 'token_invalido');
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const clip = (s: string | null | undefined, n: number): string | null => (s ? String(s).slice(0, n) : null);

// Cria refresh token opaco; guarda só o hash; retorna o valor em claro (vai no cookie).
// Sem familyId = login novo (nova sessão); com familyId = rotação da mesma sessão.
export async function issueRefreshToken(
  userId: string, ctx: SessionCtx = {}, familyId?: string,
): Promise<{ raw: string; familyId: string }> {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + env.refreshTtlSec * 1000);
  const { rows } = await pool.query<{ family_id: string }>(
    `insert into refresh_tokens (user_id, token_hash, expires_at, family_id, user_agent, ip, last_used_at)
     values ($1,$2,$3, coalesce($4::uuid, gen_random_uuid()), $5, $6, now())
     returning family_id`,
    [userId, sha256(raw), expires, familyId ?? null, clip(ctx.userAgent, 300), clip(ctx.ip, 64)],
  );
  return { raw, familyId: rows[0]!.family_id };
}

// Valida e ROTACIONA: revoga o atual, emite outro. Reuso de token revogado => mata a sessão.
export async function rotateRefreshToken(raw: string, ctx: SessionCtx = {}): Promise<{ userId: string; newRaw: string; familyId: string }> {
  const hash = sha256(raw);
  const { rows } = await pool.query<{
    id: string; user_id: string; expires_at: Date; revoked_at: Date | null; family_id: string; revoked_reason: string | null;
  }>(
    'select id, user_id, expires_at, revoked_at, family_id, revoked_reason from refresh_tokens where token_hash = $1',
    [hash],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'refresh_invalido');
  if (row.revoked_at) {
    // Sessão encerrada de propósito (logout, troca de senha, outro dispositivo):
    // só não renova. Reapresentar um token já ROTACIONADO indica roubo: derruba
    // a família inteira (a sessão comprometida), como recomenda o OAuth BCP.
    // Legado sem motivo conta como rotação (o caso mais seguro).
    if (row.revoked_reason && row.revoked_reason !== 'rotated') throw new HttpError(401, 'sessao_encerrada');
    await pool.query(
      "update refresh_tokens set revoked_at = now(), revoked_reason = 'reuse' where family_id = $1 and revoked_at is null",
      [row.family_id],
    );
    throw new HttpError(401, 'refresh_reutilizado');
  }
  if (row.expires_at.getTime() < Date.now()) throw new HttpError(401, 'refresh_expirado');
  await pool.query("update refresh_tokens set revoked_at = now(), revoked_reason = 'rotated' where id = $1", [row.id]);
  const next = await issueRefreshToken(row.user_id, ctx, row.family_id);
  return { userId: row.user_id, newRaw: next.raw, familyId: next.familyId };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await pool.query(
    "update refresh_tokens set revoked_at = now(), revoked_reason = 'logout' where token_hash = $1 and revoked_at is null",
    [sha256(raw)],
  );
}

// Encerra sessões (famílias) do usuário. `except` mantém a sessão atual.
export async function revokeSessions(userId: string, opts: { familyId?: string; except?: string } = {}): Promise<number> {
  const r = await pool.query(
    `update refresh_tokens set revoked_at = now(), revoked_reason = 'session_end'
      where user_id = $1 and revoked_at is null
        and ($2::uuid is null or family_id = $2::uuid)
        and ($3::uuid is null or family_id <> $3::uuid)`,
    [userId, opts.familyId ?? null, opts.except ?? null],
  );
  return r.rowCount ?? 0;
}
