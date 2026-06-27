import express, { type Response } from 'express';
import { asyncHandler } from './lib';
import { requireAuth, type AuthedRequest } from './auth/middleware';
import { pool } from './db';

const router = express.Router();

// GET /me — o frontend chama no load p/ hidratar currentUser
// (substitui o loadUserProfile que lia a tabela profiles do Supabase).
router.get('/me', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const { rows } = await pool.query<{ full_name: string | null; plan: 'free' | 'pro'; email_verified: boolean }>(
    `select p.full_name, p.plan, u.email_verified
       from profiles p join users u on u.id = p.id
      where p.id = $1`,
    [user.id],
  );
  const row = rows[0];
  res.json({
    id: user.id,
    email: user.email,
    fullName: row?.full_name ?? null,
    plan: row?.plan ?? 'free',
    emailVerified: row?.email_verified ?? false,
  });
}));

export default router;
