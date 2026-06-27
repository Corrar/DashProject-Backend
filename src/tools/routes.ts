import express, { type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
import { pool } from '../db';
import { PLANS } from '../plans';
import { generateNarrative } from './gemini';

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// Contrato com o frontend (CLAUDE.md §8: ~20 linhas cruas de amostra p/ o Gemini).
const schema = z.object({
  datasetName: z.string().max(120).optional(),
  columns: z.array(z.object({ name: z.string(), type: z.string().optional() })).max(200),
  sampleRows: z.array(z.record(z.unknown())).max(50),
  question: z.string().max(500).optional(),
});

function buildPrompt(input: z.infer<typeof schema>): string {
  const cols = input.columns.map((c) => `${c.name}${c.type ? ` (${c.type})` : ''}`).join(', ');
  const sample = JSON.stringify(input.sampleRows.slice(0, 20));
  return [
    'Voce e um analista de dados. Gere uma narrativa executiva, objetiva e em portugues do Brasil,',
    'destacando tendencias, outliers e recomendacoes acionaveis. Nao invente numeros fora dos dados.',
    input.datasetName ? `Dataset: ${input.datasetName}.` : '',
    `Colunas: ${cols}.`,
    `Amostra (JSON, ate 20 linhas): ${sample}.`,
    input.question ? `Pergunta do usuario: ${input.question}` : '',
  ].filter(Boolean).join('\n');
}

// Consumo de IA do mês corrente (derivado por contagem; sem cron de reset).
async function aiUsedThisMonth(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::bigint as n from ai_usage where user_id = $1 and created_at >= date_trunc('month', now())",
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

// POST /tools/analyze — FERRAMENTA PAGA. Gate: qualquer plano pago (essencial+) + quota mensal de IA.
router.post('/analyze', requireAuth, requirePlan('essencial'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const limite = PLANS[user.plan].aiMonthly;
  const usados = await aiUsedThisMonth(user.id);
  if (usados >= limite) {
    // Race concorrente é aceitável no MVP (a contagem pode estourar 1 em chamadas simultâneas).
    res.status(429).json({ error: 'quota_ia_excedida', limite, usados });
    return;
  }

  const input = schema.parse(req.body);
  const result = await generateNarrative(buildPrompt(input));
  // Só registra consumo quando o Gemini respondeu de fato.
  await pool.query('insert into ai_usage (user_id) values ($1)', [user.id]);
  res.json(result);
}));

export default router;
