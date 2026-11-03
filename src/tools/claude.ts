import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { HttpError, log } from '../lib';

export interface NarrativeResult { narrative: string; model: string; }

// Cliente único. O SDK já faz retry com backoff em 408/409/429/5xx e erro de conexão;
// timeout por tentativa de 30 s, então o pior caso fica perto de 1 min.
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey, timeout: 30_000, maxRetries: 1 });
  return client;
}

// O resumo é curto e parte de fatos já calculados no navegador: esforço baixo basta
// e gasta menos tokens de raciocínio. O Haiku não tem fallback no servidor.
function supportsServerFallback(model: string): boolean {
  return !model.startsWith('claude-haiku');
}

// Escreve o resumo em texto. Nunca loga o prompt nem a resposta (conteúdo da planilha).
export async function generateNarrative(system: string, prompt: string): Promise<NarrativeResult> {
  if (!env.anthropicApiKey) throw new HttpError(503, 'ia_nao_configurada');
  const model = env.anthropicModel;
  const fallback = supportsServerFallback(model);

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await getClient().beta.messages.create({
      model,
      max_tokens: 16_000,
      output_config: { effort: 'low' },
      // Se o classificador de segurança recusar, a própria API refaz no modelo
      // recomendado para aquela categoria, na mesma chamada.
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      log('error', 'ia_chave_invalida', { status: e.status });
      throw new HttpError(503, 'ia_nao_configurada');
    }
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      log('error', 'ia_requisicao_invalida', { status: e.status, model });
      throw new HttpError(502, 'ia_erro');
    }
    // 429 do provedor vira 503: o 429 desta rota significa "sua cota do mês acabou".
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
      log('error', 'ia_indisponivel', { status: e.status });
      throw new HttpError(503, 'ia_indisponivel');
    }
    if (e instanceof Anthropic.APIConnectionError) {
      log('error', 'ia_sem_conexao', { timeout: e instanceof Anthropic.APIConnectionTimeoutError });
      throw new HttpError(504, 'ia_indisponivel');
    }
    if (e instanceof Anthropic.APIError) {
      log('error', 'ia_erro', { status: e.status });
      throw new HttpError(502, 'ia_erro');
    }
    throw e;
  }

  if (response.stop_reason === 'refusal') {
    log('error', 'ia_recusou', { category: response.stop_details?.category ?? null });
    throw new HttpError(502, 'ia_recusou');
  }

  // Com fallback, o texto válido é o que vem depois do último bloco `fallback`.
  const blocks = response.content;
  let start = 0;
  blocks.forEach((b, i) => { if (b.type === 'fallback') start = i + 1; });
  const text = blocks.slice(start)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!text) throw new HttpError(502, 'ia_resposta_vazia');
  return { narrative: text, model: response.model };
}
