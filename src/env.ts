import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return v;
}
function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} nao e numero: ${v}`);
  return n;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: int('PORT', 8787),

  // Banco (obrigatório)
  databaseUrl: required('DATABASE_URL'),
  pgSsl: optional('PG_SSL', 'true') !== 'false',

  // URLs / CORS
  appUrl: required('APP_URL'),
  apiUrl: optional('API_URL', ''),
  corsOrigins: optional('CORS_ORIGIN', 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Auth
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  accessTtlSec: int('ACCESS_TTL_SECONDS', 900),
  refreshTtlSec: int('REFRESH_TTL_SECONDS', 60 * 60 * 24 * 30),
  refreshCookieName: optional('REFRESH_COOKIE_NAME', 'dash_rt'),
  cookieDomain: optional('COOKIE_DOMAIN', ''),

  // Email (opcional no boot; rota degrada p/ log se ausente)
  resendApiKey: optional('RESEND_API_KEY', ''),
  emailFrom: optional('EMAIL_FROM', 'Dash <onboarding@resend.dev>'),

  // Asaas (opcional no boot; rotas retornam 503 se ausente). Valores dos planos vêm de src/plans.ts.
  asaasApiKey: optional('ASAAS_API_KEY', ''),
  asaasEnv: optional('ASAAS_ENV', 'sandbox') === 'production' ? 'production' : 'sandbox',
  asaasWebhookToken: optional('ASAAS_WEBHOOK_TOKEN', ''),
  get asaasBaseUrl(): string {
    return this.asaasEnv === 'production'
      ? 'https://api.asaas.com/v3'
      : 'https://api-sandbox.asaas.com/v3';
  },

  // Job de cobrança (trilho manual). Chamado por cron externo com header x-jobs-secret.
  jobsSecret: optional('JOBS_SECRET', ''),
  renewalLeadDays: int('RENEWAL_LEAD_DAYS', 5), // gera a próxima cobrança N dias antes do fim do período
  graceDays: int('GRACE_DAYS', 3),              // tolerância após o fim do período antes do downgrade

  // Gemini (opcional no boot)
  geminiApiKey: optional('GEMINI_API_KEY', ''),
  geminiModel: optional('GEMINI_MODEL', 'gemini-2.5-flash'),
} as const;
