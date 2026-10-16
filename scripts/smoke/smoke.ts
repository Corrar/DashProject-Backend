process.env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/z'; process.env.APP_URL = 'https://app.test';
process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'production'; process.env.PORT = '18787';
process.env.RESEND_API_KEY = 'bad'; process.env.CORS_ORIGIN = 'https://app.test';
const B = require('path').resolve(__dirname, '../../src');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pool } = require(B + '/db');
let profile: any = { plan: 'essencial', billing_method: 'card', asaas_subscription_id: 'sub_1' };
pool.query = async (sql: string, params: any[]) => {
  if (/select plan from profiles/.test(sql)) return { rows: [{ plan: profile.plan }], rowCount: 1 };
  if (/billing_method, asaas_subscription_id/.test(sql)) return { rows: [profile], rowCount: 1 };
  if (/select id from users where email/.test(sql)) return { rows: [{ id: 'u1' }], rowCount: 1 };
  if (/insert into email_tokens/.test(sql)) return { rows: [], rowCount: 1 };
  if (/update refresh_tokens/.test(sql)) return { rows: [], rowCount: 1 };
  throw new Error('unexpected sql ' + sql);
};
const realFetch: typeof fetch = globalThis.fetch;
(globalThis as any).fetch = async (u: any, i: any) => String(u).includes('resend') ? ({ ok: false, status: 403, text: async () => 'domain not verified' }) : realFetch(u, i);
require(B + '/index');
const { signAccessToken } = require(B + '/auth/tokens');
setTimeout(async () => {
  const base = 'http://127.0.0.1:18787';
  let r = await realFetch(base + '/auth/logout', { method: 'POST', headers: { cookie: 'dash_rt=abc' } });
  console.log('logout', r.status, r.headers.get('set-cookie'));
  r = await realFetch(base + '/auth/request-reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com' }) });
  console.log('request-reset', r.status, await r.text());
  const tok = signAccessToken({ sub: 'u1', email: 'a@b.com', plan: 'essencial' });
  for (const [plan, body] of [['essencial', { plan: 'essencial' }], ['essencial', { plan: 'pro' }]] as const) {
    profile.plan = plan;
    r = await realFetch(base + '/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
    console.log('checkout', plan, '->', body.plan, r.status, await r.text());
  }
  process.exit(0);
}, 300);
