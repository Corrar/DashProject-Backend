import express, { type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib';
import { requireAuth, type AuthedRequest } from '../auth/middleware';
import { pool } from '../db';
import { PLANS } from '../plans';
import { generateNarrative } from './gemini';

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// Contrato com o frontend. Os insights são calculados no navegador (motor pandas
// via Pyodide, ou o motor JS); a IA só ESCREVE o resumo em texto a partir desses
// fatos. O frontend atual manda `facts` e `sampleRows: []` — nenhuma linha do
// arquivo. `sampleRows` continua aceito por compatibilidade com versões antigas.
const schema = z.object({
  datasetName: z.string().max(120).optional(),
  columns: z.array(z.object({ name: z.string().max(200), type: z.string().max(40).nullish() })).max(200),
  sampleRows: z.array(z.record(z.unknown())).max(50).optional().default([]),
  facts: z.array(z.string().max(300)).max(40).optional().default([]),
  question: z.string().max(500).nullish(),
});

function buildPrompt(input: z.infer<typeof schema>): string {
  const cols = input.columns.map((c) => `${c.name}${c.type ? ` (${c.type})` : ''}`).join(', ');
  const facts = input.facts.map((f) => `- ${f}`).join('\n');
  const sample = input.sampleRows.length ? JSON.stringify(input.sampleRows.slice(0, 20)) : '';
  return [
    'Voce e um analista de dados. Escreva um resumo executivo em portugues do Brasil, em ate 3 paragrafos curtos',
    '(no maximo 150 palavras), seguido de ate 3 recomendacoes praticas em lista com "- ".',
    'Use SOMENTE os numeros dos fatos abaixo, que ja foram calculados sobre a base inteira; nao invente numeros,',
    'nao recalcule e nao repita a lista de fatos. Sem titulos e sem tabelas.',
    input.datasetName ? `Dataset: ${input.datasetName}.` : '',
    `Colunas: ${cols}.`,
    facts ? `Fatos calculados:\n${facts}` : '',
    sample ? `Amostra (JSON, ate 20 linhas): ${sample}.` : '',
    input.question ? `Contexto do usuario: ${input.question}` : '',
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

// POST /tools/analyze — análise de IA. Gate: conta logada + quota mensal do plano (Free = 1,
// Essencial = 50, Pro = 300; ver src/plans.ts). Anônimo recebe 401 e o frontend pede cadastro.
router.post('/analyze', requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
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

export { schema as analyzeSchema, buildPrompt };
