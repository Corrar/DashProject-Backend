import express, { type Response } from 'express';
import { asyncHandler } from './lib';
import { requireAuth, type AuthedRequest } from './auth/middleware';
import { pool } from './db';
import { PLANS, isPlanId, type PlanId } from './plans';

const router = express.Router();

// GET /me — o frontend chama no load p/ hidratar currentUser e gatear a UX.
// (substitui o loadUserProfile que lia a tabela profiles do Supabase).
router.get('/me', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { rows } = await pool.query<{ full_name: string | null; plan: string; email_verified: boolean; ai_used: string }>(
    `select p.full_name,
            p.plan,
            u.email_verified,
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

export default router;
