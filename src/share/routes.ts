// src/share/routes.ts — links públicos de dashboard (plano Pro: PLANS.pro.shareLinks).
//
// O frontend manda um RETRATO do dashboard (blocos com valores agregados, sem as
// linhas do arquivo); qualquer pessoa com o link vê em modo leitura. O link só
// fica no ar enquanto o dono tem um plano com shareLinks — no downgrade ele para
// de abrir (e volta se a pessoa reassinar), sem apagar nada.
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db';
import { env } from '../env';
import { HttpError, asyncHandler } from '../lib';
import { requireAuth, type AuthedRequest } from '../auth/middleware';
import { PLANS, isPlanId } from '../plans';

const router = express.Router();
router.use(express.json({ limit: '512kb' }));

const MAX_ACTIVE_LINKS = 50;

const blockSchema = z.object({
  id: z.string().max(80),
  kind: z.enum(['kpi', 'chart', 'ranking', 'insights']),
  span: z.number().int().min(1).max(12),
  props: z.record(z.unknown()).nullable(),
});
const payloadSchema = z.object({
  version: z.literal(1),
  accent: z.string().max(40).optional(),
  branding: z.boolean(),
  meta: z.object({
    title: z.string().max(120),
    fileName: z.string().max(200).optional(),
    period: z.string().max(60).optional(),
    rows: z.number().int().nonnegative().optional(),
    totalRows: z.number().int().nonnegative().optional(),
  }),
  aiSummary: z.string().max(10_000).nullable().optional(),
  blocks: z.array(blockSchema).max(60),
});
const createSchema = z.object({ title: z.string().min(1).max(120), payload: payloadSchema });

function shareUrl(slug: string): string {
  return `${env.appUrl.replace(/\/+$/, '')}/?s=${slug}`;
}

function requireShareLinks(req: AuthedRequest): void {
  if (!PLANS[req.user!.plan].shareLinks) throw new HttpError(402, 'plano_insuficiente');
}

// POST /share — cria um link para o retrato enviado.
router.post('/', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  requireShareLinks(req);
  const { title, payload } = createSchema.parse(req.body);
  const userId = req.user!.id;
  const { rows } = await pool.query<{ n: string }>(
    'select count(*)::bigint as n from shared_dashboards where user_id = $1 and revoked_at is null', [userId],
  );
  if (Number(rows[0]?.n ?? 0) >= MAX_ACTIVE_LINKS) {
    throw new HttpError(409, 'limite_links', `Você já tem ${MAX_ACTIVE_LINKS} links ativos. Desative algum para criar outro.`);
  }
  // 12 caracteres base64url (72 bits): impossível de adivinhar por enumeração.
  const slug = crypto.randomBytes(9).toString('base64url');
  await pool.query(
    'insert into shared_dashboards (slug, user_id, title, payload) values ($1,$2,$3,$4)',
    [slug, userId, title, JSON.stringify(payload)],
  );
  res.status(201).json({ slug, url: shareUrl(slug) });
}));

// GET /share — links ativos do usuário (para gerenciar/desativar).
router.get('/', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { rows } = await pool.query<{ slug: string; title: string; created_at: Date }>(
    `select slug, title, created_at from shared_dashboards
      where user_id = $1 and revoked_at is null order by created_at desc limit $2`,
    [req.user!.id, MAX_ACTIVE_LINKS],
  );
  res.json({ links: rows.map((r) => ({ slug: r.slug, title: r.title, createdAt: r.created_at, url: shareUrl(r.slug) })) });
}));

// DELETE /share/:slug — desativa um link do próprio usuário.
router.delete('/:slug', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const slug = String(req.params.slug ?? '');
  const r = await pool.query(
    'update shared_dashboards set revoked_at = now() where slug = $1 and user_id = $2 and revoked_at is null',
    [slug, req.user!.id],
  );
  if (!r.rowCount) throw new HttpError(404, 'link_nao_encontrado');
  res.json({ ok: true });
}));

// GET /share/:slug — público (sem login). 404 se não existe, foi desativado ou o
// dono não tem mais um plano com links públicos.
router.get('/:slug', asyncHandler(async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '');
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(slug)) throw new HttpError(404, 'link_nao_encontrado');
  const { rows } = await pool.query<{ title: string; payload: unknown; created_at: Date; plan: string }>(
    `select s.title, s.payload, s.created_at, p.plan
       from shared_dashboards s join profiles p on p.id = s.user_id
      where s.slug = $1 and s.revoked_at is null`,
    [slug],
  );
  const row = rows[0];
  if (!row || !isPlanId(row.plan) || !PLANS[row.plan].shareLinks) throw new HttpError(404, 'link_nao_encontrado');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ title: row.title, createdAt: row.created_at, payload: row.payload });
}));

export default router;
