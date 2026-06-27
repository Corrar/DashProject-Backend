import { env } from '../env';
import { HttpError, log } from '../lib';

export interface GeminiResult { narrative: string; model: string; }

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await run(ac.signal); } finally { clearTimeout(t); }
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// Chamada ao Gemini com timeout duro + retry/backoff com jitter em 429/5xx.
export async function generateNarrative(prompt: string, timeoutMs = 20_000): Promise<GeminiResult> {
  if (!env.geminiApiKey) throw new HttpError(503, 'gemini_nao_configurado');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`;
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await withTimeout(
        (signal) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
        timeoutMs,
      );
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`gemini_${r.status}`);
      } else if (!r.ok) {
        const t = await r.text();
        throw new HttpError(502, 'gemini_erro', t.slice(0, 300));
      } else {
        const json = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        if (!text) throw new HttpError(502, 'gemini_resposta_vazia');
        return { narrative: text, model: env.geminiModel };
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
    }
    await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 200));
  }
  log('error', 'gemini_esgotou_retries', { err: String(lastErr) });
  throw new HttpError(504, 'gemini_indisponivel');
}
