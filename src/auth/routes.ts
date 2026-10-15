import express, { type Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../db';
import { env } from '../env';
import { HttpError, asyncHandler, log } from '../lib';
import { assertStrongPassword, hashPassword, verifyPassword } from './passwords';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, type SessionCtx } from './tokens';
import { sendVerifyEmail, sendResetEmail } from './email';
import { isPlanId, type PlanId } from '../plans';
import { requireAuth, type AuthedRequest } from './middleware';
import { rateLimit } from '../rateLimit';

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

const credsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
const signupSchema = credsSchema.extend({ full_name: z.string().max(120).optional() });

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function sessionCtx(req: express.Request): SessionCtx {
  return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
}

// Limites por IP (+ e-mail no login): força bruta e spam de e-mail.
const emailKey = (req: express.Request): string | null => {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' ? e.toLowerCase().slice(0, 254) : null;
};
const loginLimit = rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10, key: emailKey });
const signupLimit = rateLimit({ name: 'signup', windowMs: 60 * 60_000, max: 10 });
const resetLimit = rateLimit({ name: 'reset', windowMs: 60 * 60_000, max: 5 });
const resendLimit = rateLimit({ name: 'resend', windowMs: 60 * 60_000, max: 3 });

function refreshCookieOptions() {
  const prod = env.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? ('none' as const) : ('lax' as const), // cross-site (Vercel -> Render) exige none+secure
    path: '/auth',
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
  };
}
function setRefreshCookie(res: Response, raw: string): void {
  res.cookie(env.refreshCookieName, raw, { ...refreshCookieOptions(), maxAge: env.refreshTtlSec * 1000 });
}
// O navegador só apaga o cookie se os atributos baterem com os do set. Sem
// SameSite=None+Secure, o Set-Cookie de remoção é descartado na resposta
// cross-site e o refresh já revogado fica no navegador — no próximo boot ele
// é reapresentado, cai na detecção de reuso e derruba TODAS as sessões do usuário.
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(env.refreshCookieName, refreshCookieOptions());
}

async function emailToken(userId: string, purpose: 'verify' | 'reset', ttlMs: number): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    'insert into email_tokens (user_id, token_hash, purpose, expires_at) values ($1,$2,$3,$4)',
    [userId, sha256(raw), purpose, new Date(Date.now() + ttlMs)],
  );
  return raw;
}

// POST /auth/signup
router.post('/signup', signupLimit, asyncHandler(async (req, res) => {
  const body = signupSchema.parse(req.body);
  assertStrongPassword(body.password);
  const email = body.email.toLowerCase();
  const hash = await hashPassword(body.password);

  const client = await pool.connect();
  let userId: string;
  try {
    await client.query('begin');
    const exists = await client.query('select 1 from users where email = $1', [email]);
    if (exists.rowCount && exists.rowCount > 0) throw new HttpError(409, 'email_em_uso');
    const u = await client.query<{ id: string }>(
      'insert into users (email, password_hash) values ($1,$2) returning id',
      [email, hash],
    );
    userId = u.rows[0]!.id;
    await client.query('insert into profiles (id, full_name) values ($1,$2)', [userId, body.full_name ?? null]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // E-mail de verificação é best-effort: a conta já está criada e commitada acima.
  // Se o envio falhar (ex.: Resend sem domínio verificado -> 403), logamos e seguimos —
  // o usuário recebe access_token + cookie normalmente e a verificação pode ser reenviada.
  // Nunca propaga: o signup não pode dar 500 (e sonegar a sessão) por causa do e-mail.
  try {
    const token = await emailToken(userId, 'verify', 24 * 60 * 60 * 1000);
    await sendVerifyEmail(email, `${env.appUrl}/?verify=${token}`);
  } catch (e) {
    log('warn', 'signup_verify_email_falhou', {
      userId,
      motivo: e instanceof Error ? e.message : String(e),
    });
  }

  const session = await issueRefreshToken(userId, sessionCtx(req));
  const access = signAccessToken({ sub: userId, email, plan: 'free', sid: session.familyId });
  setRefreshCookie(res, session.raw);
  res.status(201).json({ access_token: access, user: { id: userId, email, plan: 'free', emailVerified: false } });
}));

// POST /auth/login
router.post('/login', loginLimit, asyncHandler(async (req, res) => {
  const body = credsSchema.parse(req.body);
  const email = body.email.toLowerCase();
  const { rows } = await pool.query<{ id: string; password_hash: string; email_verified: boolean }>(
    'select id, password_hash, email_verified from users where email = $1', [email],
  );
  const row = rows[0];
  // Resposta uniforme p/ não revelar existência de e-mail.
  if (!row || !(await verifyPassword(body.password, row.password_hash))) {
    throw new HttpError(401, 'credenciais_invalidas');
  }
  const planRow = await pool.query<{ plan: string }>('select plan from profiles where id = $1', [row.id]);
  const rawPlan = planRow.rows[0]?.plan;
  const plan: PlanId = isPlanId(rawPlan) ? rawPlan : 'free';
  const session = await issueRefreshToken(row.id, sessionCtx(req));
  const access = signAccessToken({ sub: row.id, email, plan, sid: session.familyId });
  setRefreshCookie(res, session.raw);
  res.json({ access_token: access, user: { id: row.id, email, plan, emailVerified: row.email_verified } });
}));

// POST /auth/refresh — lê o cookie httpOnly e rotaciona.
router.post('/refresh', asyncHandler(async (req, res) => {
  const raw = req.cookies?.[env.refreshCookieName];
  if (!raw) throw new HttpError(401, 'sem_refresh');
  const { userId, newRaw, familyId } = await rotateRefreshToken(raw, sessionCtx(req));
  const u = await pool.query<{ email: string; plan: string }>(
    'select u.email, p.plan from users u join profiles p on p.id = u.id where u.id = $1', [userId],
  );
  const row = u.rows[0];
  if (!row) throw new HttpError(401, 'usuario_inexistente');
  const plan: PlanId = isPlanId(row.plan) ? row.plan : 'free';
  setRefreshCookie(res, newRaw);
  res.json({ access_token: signAccessToken({ sub: userId, email: row.email, plan, sid: familyId }) });
}));

// POST /auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
  const raw = req.cookies?.[env.refreshCookieName];
  if (raw) await revokeRefreshToken(raw);
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

// POST /auth/verify-email  { token }
router.post('/verify-email', asyncHandler(async (req, res) => {
  const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
  const { rows } = await pool.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    "select id, user_id, expires_at, used_at from email_tokens where token_hash = $1 and purpose = 'verify'",
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || row.used_at || row.expires_at.getTime() < Date.now()) throw new HttpError(400, 'token_invalido');
  await pool.query('update email_tokens set used_at = now() where id = $1', [row.id]);
  await pool.query('update users set email_verified = true where id = $1', [row.user_id]);
  res.json({ ok: true });
}));

// POST /auth/request-reset { email }  — sempre 200 (não revela e-mail).
router.post('/request-reset', resetLimit, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const { rows } = await pool.query<{ id: string }>('select id from users where email = $1', [email.toLowerCase()]);
  const row = rows[0];
  if (row) {
    // Best-effort, como no signup: uma falha do provedor não pode virar 500 só
    // para e-mails cadastrados (isso revelaria quais e-mails existem).
    try {
      const token = await emailToken(row.id, 'reset', 60 * 60 * 1000);
      await sendResetEmail(email.toLowerCase(), `${env.appUrl}/?reset=${token}`);
    } catch (e) {
      log('warn', 'reset_email_falhou', { userId: row.id, motivo: e instanceof Error ? e.message : String(e) });
    }
  }
  res.json({ ok: true });
}));

// POST /auth/reset { token, password }
router.post('/reset', resetLimit, asyncHandler(async (req, res) => {
  const { token, password } = z.object({ token: z.string().min(10), password: z.string() }).parse(req.body);
  assertStrongPassword(password);
  const { rows } = await pool.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    "select id, user_id, expires_at, used_at from email_tokens where token_hash = $1 and purpose = 'reset'",
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || row.used_at || row.expires_at.getTime() < Date.now()) throw new HttpError(400, 'token_invalido');
  const pwHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('update email_tokens set used_at = now() where id = $1', [row.id]);
    await client.query('update users set password_hash = $1 where id = $2', [pwHash, row.user_id]);
    // invalida todas as sessões após reset
    await client.query("update refresh_tokens set revoked_at = now(), revoked_reason = 'reset' where user_id = $1 and revoked_at is null", [row.user_id]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// POST /auth/resend-verification — reenvia o link de confirmação (logado).
router.post('/resend-verification', requireAuth, resendLimit, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { rows } = await pool.query<{ email: string; email_verified: boolean }>(
    'select email, email_verified from users where id = $1', [req.user!.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'usuario_inexistente');
  if (row.email_verified) throw new HttpError(409, 'email_ja_confirmado');
  // Links anteriores deixam de valer: só o mais novo confirma.
  await pool.query("update email_tokens set used_at = now() where user_id = $1 and purpose = 'verify' and used_at is null", [req.user!.id]);
  const token = await emailToken(req.user!.id, 'verify', 24 * 60 * 60 * 1000);
  await sendVerifyEmail(row.email, `${env.appUrl}/?verify=${token}`);
  res.json({ ok: true });
}));

export default router;
