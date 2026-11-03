import express, { type Response } from 'express';
import { z } from 'zod';
import { HttpError, asyncHandler, log } from './lib';
import { requireAuth, invalidatePlan, type AuthedRequest } from './auth/middleware';
import { pool } from './db';
import { PLANS, isPlanId, type PlanId } from './plans';
import { assertStrongPassword, hashPassword, verifyPassword } from './auth/passwords';
import { revokeSessions } from './auth/tokens';
import { clearRefreshCookie } from './auth/routes';
import { sendAccountDeletedEmail, sendPasswordChangedEmail } from './auth/email';
import { deletePayment, deleteSubscription } from './billing/asaas';
import { rateLimit } from './rateLimit';

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

const userKey = (req: express.Request): string | null => (req as AuthedRequest).user?.id ?? null;
const passwordLimit = rateLimit({ name: 'password', windowMs: 60 * 60_000, max: 10, key: userKey });
const deleteLimit = rateLimit({ name: 'delete', windowMs: 60 * 60_000, max: 5, key: userKey });

// IP mascarado para a tela de sessões (o suficiente para reconhecer a rede).
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) { const p = v4.split('.'); return `${p[0]}.${p[1]}.•••.${p[3]}`; }
  const parts = ip.split(':').filter(Boolean);
  return parts.length > 2 ? `${parts.slice(0, 2).join(':')}:•••` : ip;
}

// GET /me — o frontend chama no load p/ hidratar currentUser e gatear a UX.
// (substitui o loadUserProfile que lia a tabela profiles do Supabase).
router.get('/me', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { rows } = await pool.query<{
    full_name: string | null; plan: string; email_verified: boolean; ai_used: string; created_at: Date; waitlist: string[] | null;
    billing_method: string | null; current_period_end: Date | null;
    billing_cycle: string | null; auto_renew: boolean | null;
  }>(
    `select p.full_name,
            p.plan,
            p.billing_method,
            p.current_period_end,
            p.billing_cycle,
            p.auto_renew,
            u.email_verified,
            u.created_at,
            (select array_agg(w.feature) from waitlist w where w.user_id = p.id) as waitlist,
            (select count(*)::bigint from ai_usage a
              where a.user_id = p.id and a.created_at >= date_trunc('month', now())) as ai_used
       from profiles p join users u on u.id = p.id
      where p.id = $1`,
    [user.id],
  );
  const row = rows[0];
  const plan: PlanId = isPlanId(row?.plan) ? row.plan : 'free';
  const def = PLANS[plan];

  res.json({
    id: user.id,
    email: user.email,
    fullName: row?.full_name ?? null,
    plan,
    emailVerified: row?.email_verified ?? false,
    createdAt: row?.created_at ?? null,
    waitlist: row?.waitlist ?? [],
    // Para a UI de faturamento: trilho (card/pix/boleto) e fim do período pago.
    billingMethod: plan === 'free' ? null : (row?.billing_method ?? null),
    currentPeriodEnd: plan === 'free' ? null : (row?.current_period_end ?? null),
    billingCycle: plan === 'free' ? null : (row?.billing_cycle === 'yearly' ? 'yearly' : 'monthly'),
    autoRenew: plan === 'free' ? null : (row?.auto_renew ?? true),
    limits: {
      aiMonthly: def.aiMonthly,
      aiUsed: Number(row?.ai_used ?? 0),
      maxRows: def.maxRows,
      canExport: def.canExport,
      shareLinks: def.shareLinks,
      removeBranding: def.removeBranding,
    },
  });
}));

// PATCH /me — nome de exibição.
router.patch('/me', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { fullName } = z.object({ fullName: z.string().max(120).nullable() }).parse(req.body);
  const name = fullName && fullName.trim() ? fullName.trim() : null;
  await pool.query('update profiles set full_name = $1 where id = $2', [name, req.user!.id]);
  res.json({ ok: true, fullName: name });
}));

// POST /me/password — troca a senha (exige a atual) e encerra as outras sessões.
router.post('/me/password', requireAuth, passwordLimit, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) }).parse(req.body);
  const { rows } = await pool.query<{ password_hash: string; email: string }>(
    'select password_hash, email from users where id = $1', [req.user!.id],
  );
  const row = rows[0];
  if (!row || !(await verifyPassword(body.current, row.password_hash))) throw new HttpError(403, 'senha_atual_incorreta');
  assertStrongPassword(body.next);
  await pool.query('update users set password_hash = $1, updated_at = now() where id = $2', [await hashPassword(body.next), req.user!.id]);
  const revoked = await revokeSessions(req.user!.id, { except: req.user!.sid });
  try { await sendPasswordChangedEmail(row.email); } catch (e) {
    log('warn', 'email_senha_alterada_falhou', { motivo: e instanceof Error ? e.message : String(e) });
  }
  res.json({ ok: true, revoked });
}));

// GET /me/sessions — sessões ativas (uma por login; a rotação mantém a sessão).
router.get('/me/sessions', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { rows } = await pool.query<{ family_id: string; user_agent: string | null; ip: string | null; last_used_at: Date; started_at: Date }>(
    `select t.family_id, t.user_agent, t.ip, coalesce(t.last_used_at, t.created_at) as last_used_at,
            (select min(f.created_at) from refresh_tokens f where f.family_id = t.family_id) as started_at
       from refresh_tokens t
      where t.user_id = $1 and t.revoked_at is null and t.expires_at > now()
      order by last_used_at desc
      limit 20`,
    [req.user!.id],
  );
  res.json({ sessions: rows.map((r) => ({
    id: r.family_id, userAgent: r.user_agent, ip: maskIp(r.ip),
    lastUsedAt: r.last_used_at, startedAt: r.started_at, current: r.family_id === req.user!.sid,
  })) });
}));

// DELETE /me/sessions/:id — encerra uma sessão.
router.delete('/me/sessions/:id', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const n = await revokeSessions(req.user!.id, { familyId: id });
  if (!n) throw new HttpError(404, 'sessao_nao_encontrada');
  res.json({ ok: true, current: id === req.user!.sid });
}));

// POST /me/sessions/revoke-others — encerra todas as sessões menos a atual.
router.post('/me/sessions/revoke-others', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  if (!req.user!.sid) throw new HttpError(409, 'sessao_atual_desconhecida', 'Entre de novo para gerenciar as sessões.');
  res.json({ ok: true, revoked: await revokeSessions(req.user!.id, { except: req.user!.sid }) });
}));

// GET /me/ai-usage — análises por mês (12 meses) e as mais recentes.
router.get('/me/ai-usage', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const months = await pool.query<{ month: string; count: string }>(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::bigint as count
       from ai_usage where user_id = $1 and created_at >= date_trunc('month', now()) - interval '11 months'
      group by 1 order by 1`,
    [req.user!.id],
  );
  const recent = await pool.query<{ created_at: Date }>(
    'select created_at from ai_usage where user_id = $1 order by created_at desc limit 20', [req.user!.id],
  );
  res.json({
    months: months.rows.map((m) => ({ month: m.month, count: Number(m.count) })),
    recent: recent.rows.map((r) => r.created_at),
  });
}));

// POST /me/waitlist — interesse em recurso futuro (hoje: workspace do plano Team).
router.post('/me/waitlist', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { feature, source } = z.object({ feature: z.enum(['workspace']), source: z.string().max(40).optional() }).parse(req.body);
  await pool.query(
    'insert into waitlist (user_id, feature, source) values ($1,$2,$3) on conflict (user_id, feature) do nothing',
    [req.user!.id, feature, source ?? null],
  );
  res.json({ ok: true });
}));

// GET /me/export — portabilidade (LGPD art. 18): tudo o que o servidor guarda sobre a conta.
// Os arquivos e dashboards ficam no navegador, então não aparecem aqui.
router.get('/me/export', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const id = req.user!.id;
  const [acc, usage, shares, cycles, sessions, waits] = await Promise.all([
    pool.query(`select u.email, u.email_verified, u.created_at, p.full_name, p.plan, p.billing_method, p.billing_cycle,
                       p.auto_renew, p.current_period_end
                  from users u join profiles p on p.id = u.id where u.id = $1`, [id]),
    pool.query("select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as count from ai_usage where user_id = $1 group by 1 order by 1", [id]),
    pool.query('select slug, title, created_at, revoked_at from shared_dashboards where user_id = $1 order by created_at', [id]),
    pool.query('select plan, billing_type, value, due_date, period_start, period_end, status, created_at from billing_cycles where user_id = $1 order by created_at', [id]),
    pool.query('select count(distinct family_id)::int as n from refresh_tokens where user_id = $1 and revoked_at is null and expires_at > now()', [id]),
    pool.query('select feature, created_at from waitlist where user_id = $1', [id]),
  ]);
  const a = acc.rows[0] ?? {};
  const out = {
    exportadoEm: new Date().toISOString(),
    conta: { email: a.email, nome: a.full_name ?? null, emailConfirmado: a.email_verified, criadaEm: a.created_at },
    plano: { plano: a.plan, metodo: a.billing_method ?? null, ciclo: a.billing_cycle, renovacaoAutomatica: a.auto_renew, periodoPagoAte: a.current_period_end ?? null },
    analisesDeIaPorMes: usage.rows,
    linksPublicos: shares.rows,
    cobrancasPixBoleto: cycles.rows,
    sessoesAtivas: sessions.rows[0]?.n ?? 0,
    listaDeEspera: waits.rows,
    observacao: 'Arquivos, dashboards e análises salvos ficam só no seu navegador e não estão neste arquivo.',
  };
  res.setHeader('Content-Disposition', 'attachment; filename="dash-meus-dados.json"');
  res.json(out);
}));

// DELETE /me — exclui a conta (LGPD). Exige a senha e a palavra EXCLUIR.
// Ordem: cancela a cobrança recorrente (se falhar, nada é apagado), cancela
// cobranças Pix pendentes (best-effort), arquiva as cobranças sem dado pessoal
// e apaga o usuário (o resto cai em cascata).
router.delete('/me', requireAuth, deleteLimit, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = z.object({ password: z.string().min(1).max(200), confirm: z.literal('EXCLUIR') }).parse(req.body);
  const id = req.user!.id;
  const { rows } = await pool.query<{
    email: string; password_hash: string; plan: string; asaas_subscription_id: string | null; auto_renew: boolean | null;
  }>(
    `select u.email, u.password_hash, p.plan, p.asaas_subscription_id, p.auto_renew
       from users u join profiles p on p.id = u.id where u.id = $1`, [id],
  );
  const row = rows[0];
  if (!row || !(await verifyPassword(body.password, row.password_hash))) throw new HttpError(403, 'senha_incorreta');

  if (row.asaas_subscription_id && row.plan !== 'free' && row.auto_renew !== false) {
    await deleteSubscription(row.asaas_subscription_id); // erro → 502 e a conta fica
  }
  const pending = await pool.query<{ asaas_payment_id: string }>(
    "select asaas_payment_id from billing_cycles where user_id = $1 and status = 'PENDING' and asaas_payment_id is not null", [id],
  );
  for (const p of pending.rows) {
    try { await deletePayment(p.asaas_payment_id); } catch (e) {
      log('warn', 'excluir_conta_cobranca_pendente', { motivo: e instanceof Error ? e.message : String(e) });
    }
  }

  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into billing_archive (asaas_customer_id, asaas_payment_id, plan, billing_type, value, due_date, period_start, period_end, status)
       select p.asaas_customer_id, bc.asaas_payment_id, bc.plan, bc.billing_type, bc.value, bc.due_date, bc.period_start, bc.period_end,
              case when bc.status = 'PENDING' then 'CANCELED' else bc.status end
         from billing_cycles bc join profiles p on p.id = bc.user_id
        where bc.user_id = $1`,
      [id],
    );
    await c.query('delete from users where id = $1', [id]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  invalidatePlan(id);
  log('info', 'conta_excluida', { userId: id });
  try { await sendAccountDeletedEmail(row.email); } catch (e) {
    log('warn', 'email_conta_excluida_falhou', { motivo: e instanceof Error ? e.message : String(e) });
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

export default router;
