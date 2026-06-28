import express, { type Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../db';
import { env } from '../env';
import { HttpError, asyncHandler, log } from '../lib';
import { assertStrongPassword, hashPassword, verifyPassword } from './passwords';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from './tokens';
import { sendVerifyEmail, sendResetEmail } from './email';

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

function setRefreshCookie(res: Response, raw: string): void {
  const prod = env.nodeEnv === 'production';
  res.cookie(env.refreshCookieName, raw, {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? 'none' : 'lax', // cross-site (Vercel -> Render) exige none+secure
    path: '/auth',
    maxAge: env.refreshTtlSec * 1000,
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
  });
}
function clearRefreshCookie(res: Response): void {
  res.clearCookie(env.refreshCookieName, {
    path: '/auth',
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
  });
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
router.post('/signup', asyncHandler(async (req, res) => {
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

  const access = signAccessToken({ sub: userId, email, plan: 'free' });
  setRefreshCookie(res, await issueRefreshToken(userId));
  res.status(201).json({ access_token: access, user: { id: userId, email, plan: 'free', emailVerified: false } });
}));

// POST /auth/login
router.post('/login', asyncHandler(async (req, res) => {
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
  const planRow = await pool.query<{ plan: 'free' | 'pro' }>('select plan from profiles where id = $1', [row.id]);
  const plan: 'free' | 'pro' = planRow.rows[0]?.plan === 'pro' ? 'pro' : 'free';
  const access = signAccessToken({ sub: row.id, email, plan });
  setRefreshCookie(res, await issueRefreshToken(row.id));
  res.json({ access_token: access, user: { id: row.id, email, plan, emailVerified: row.email_verified } });
}));

// POST /auth/refresh — lê o cookie httpOnly e rotaciona.
router.post('/refresh', asyncHandler(async (req, res) => {
  const raw = req.cookies?.[env.refreshCookieName];
  if (!raw) throw new HttpError(401, 'sem_refresh');
  const { userId, newRaw } = await rotateRefreshToken(raw);
  const u = await pool.query<{ email: string; plan: 'free' | 'pro' }>(
    'select u.email, p.plan from users u join profiles p on p.id = u.id where u.id = $1', [userId],
  );
  const row = u.rows[0];
  if (!row) throw new HttpError(401, 'usuario_inexistente');
  const plan: 'free' | 'pro' = row.plan === 'pro' ? 'pro' : 'free';
  setRefreshCookie(res, newRaw);
  res.json({ access_token: signAccessToken({ sub: userId, email: row.email, plan }) });
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
router.post('/request-reset', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const { rows } = await pool.query<{ id: string }>('select id from users where email = $1', [email.toLowerCase()]);
  const row = rows[0];
  if (row) {
    const token = await emailToken(row.id, 'reset', 60 * 60 * 1000);
    await sendResetEmail(email.toLowerCase(), `${env.appUrl}/?reset=${token}`);
  }
  res.json({ ok: true });
}));

// POST /auth/reset { token, password }
router.post('/reset', asyncHandler(async (req, res) => {
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
    await client.query('update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [row.user_id]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

export default router;
