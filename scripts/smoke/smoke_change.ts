process.env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/z'; process.env.APP_URL = 'https://app.test';
process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'production'; process.env.PORT = '18789'; process.env.CORS_ORIGIN = 'https://app.test';
process.env.ASAAS_API_KEY = 'k'; process.env.ASAAS_WEBHOOK_TOKEN = 'wh';
const B = require('path').resolve(__dirname, '../../src');
const { pool } = require(B + '/db');
let profile: any = { plan: 'essencial', billing_method: 'card', asaas_subscription_id: 'sub_9', current_period_end: new Date(Date.now() + 10 * 864e5) };
const setPlans: any[] = [];
const fakeClient = { query: async (sql: string, p: any[]) => { if (/update profiles set/.test(sql)) { setPlans.push(p[1]); profile.plan = p[1]; } return { rows: [], rowCount: 1 }; }, release() {} };
pool.connect = async () => fakeClient;
pool.query = async (sql: string, p: any[]) => {
  if (/select plan from profiles/.test(sql)) return { rows: [{ plan: profile.plan }] };
  if (/select billing_method, asaas_subscription_id/.test(sql)) return { rows: [profile] };
  if (/insert into processed_webhook_events/.test(sql)) return { rowCount: 1, rows: [] };
  if (/select 1 from processed_webhook_events/.test(sql)) return { rowCount: 0, rows: [] };
  if (/select user_id, plan, method, cycle from checkout_sessions/.test(sql)) return { rows: [{ user_id: 'u1', plan: 'essencial', method: 'card', cycle: 'monthly' }] };
  if (/select current_period_end from profiles/.test(sql)) return { rows: [{ current_period_end: profile.current_period_end }] };
  if (/select id from profiles where asaas_subscription_id/.test(sql)) return { rows: [{ id: 'u1' }] };
  if (/from profiles p join users u/.test(sql)) return { rows: [{ full_name: 'A', plan: profile.plan, email_verified: true, ai_used: '1', billing_method: profile.billing_method, current_period_end: profile.current_period_end }] };
  throw new Error('unexpected ' + sql);
};
const asaasCalls: any[] = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (u: any, i: any) => {
  if (String(u).includes('asaas.com')) { asaasCalls.push([i.method, String(u).replace(/^.*\/v3/, ''), JSON.parse(i.body)]); return { ok: true, status: 200, text: async () => '{"id":"sub_9"}' }; }
  return realFetch(u, i);
};
require(B + '/index');
const { signAccessToken } = require(B + '/auth/tokens');
const { invalidatePlan } = require(B + '/auth/middleware');
setTimeout(async () => {
  const base = 'http://127.0.0.1:18789';
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + signAccessToken({ sub: 'u1', email: 'a@b.com', plan: 'essencial' }) };
  let r = await fetch(base + '/me', { headers: H }); const me: any = await r.json(); console.log('/me', me.plan, me.billingMethod, !!me.currentPeriodEnd);
  r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro' }) });
  console.log('upgrade', r.status, await r.json(), '| asaas:', JSON.stringify(asaasCalls.pop()), '| setPlan:', setPlans.pop());
  invalidatePlan('u1');
  r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'essencial' }) });
  console.log('downgrade', r.status, await r.json(), '| asaas value:', asaasCalls.pop()?.[2]?.value, '| setPlan called:', setPlans.length);
  // Next renewal of the subscription at the new (lower) value, still tied to the original pro? checkout session
  r = await fetch(base + '/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'wh' },
    body: JSON.stringify({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_2', subscription: 'sub_9', checkoutSession: 'chk_1', value: 29.9, billingType: 'CREDIT_CARD', customer: 'cus_1' } }) });
  console.log('webhook renewal 29.90', r.status, '| plan set to:', setPlans.pop());
  profile = { ...profile, billing_method: 'pix', asaas_subscription_id: null, plan: 'essencial' }; invalidatePlan('u1');
  r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro' }) });
  console.log('pix user', r.status, (await r.json() as any).error);
  process.exit(0);
}, 300);
