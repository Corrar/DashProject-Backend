import express, { type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib';
import { requireAuth, requirePlan, type AuthedRequest } from '../auth/middleware';
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

// POST /tools/analyze — FERRAMENTA PAGA. Gate server-side: usuário free recebe 402.
router.post('/analyze', requireAuth, requirePlan('pro'), asyncHandler(async (req: AuthedRequest, res: Response) => {
  const input = schema.parse(req.body);
  const result = await generateNarrative(buildPrompt(input));
  res.json(result);
}));

export default router;
