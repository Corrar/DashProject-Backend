process.env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/z'; process.env.APP_URL = 'https://app.test';
process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'production'; process.env.PORT = '18788'; process.env.CORS_ORIGIN = 'https://app.test';
const B = require('path').resolve(__dirname, '../../src');
const { pool } = require(B + '/db');
const store: Record<string, any> = {};
let plan = 'pro';
pool.query = async (sql: string, p: any[]) => {
  if (/select plan from profiles/.test(sql)) return { rows: [{ plan }], rowCount: 1 };
  if (/select count\(\*\)::bigint as n from shared_dashboards/.test(sql)) return { rows: [{ n: String(Object.values(store).filter((r: any) => !r.revoked).length) }] };
  if (/insert into shared_dashboards/.test(sql)) { store[p[0]] = { user: p[1], title: p[2], payload: JSON.parse(p[3]), revoked: false, created_at: new Date() }; return { rowCount: 1, rows: [] }; }
  if (/from shared_dashboards s join profiles/.test(sql)) { const r = store[p[0]]; return { rows: r && !r.revoked ? [{ title: r.title, payload: r.payload, created_at: r.created_at, plan }] : [] }; }
  if (/update shared_dashboards set revoked_at/.test(sql)) { const r = store[p[0]]; if (r && !r.revoked && r.user === p[1]) { r.revoked = true; return { rowCount: 1 }; } return { rowCount: 0 }; }
  if (/select slug, title, created_at from shared_dashboards/.test(sql)) return { rows: Object.entries(store).filter(([, r]: any) => !r.revoked).map(([slug, r]: any) => ({ slug, title: r.title, created_at: r.created_at })) };
  throw new Error('unexpected ' + sql);
};
require(B + '/index');
const { signAccessToken } = require(B + '/auth/tokens');
const { invalidatePlan } = require(B + '/auth/middleware');
setTimeout(async () => {
  const base = 'http://127.0.0.1:18788';
  const tok = signAccessToken({ sub: 'u1', email: 'a@b.com', plan: 'pro' });
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
  const payload = { version: 1, branding: true, meta: { title: 'Visão geral', period: 'Todo o período', rows: 35 }, aiSummary: null, blocks: [{ id: 'k1', kind: 'kpi', span: 3, props: { label: 'Valor', value: 10 } }] };
  let r = await fetch(base + '/share', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Meu painel', payload }) });
  const created: any = await r.json(); console.log('create pro', r.status, created);
  r = await fetch(base + '/share/' + created.slug); console.log('public get', r.status, r.headers.get('cache-control'), JSON.stringify(await r.json()).slice(0, 90));
  r = await fetch(base + '/share', { headers: H }); console.log('list', r.status, (await r.json() as any).links.length);
  r = await fetch(base + '/share', { method: 'POST', headers: H, body: JSON.stringify({ title: 'x', payload: { ...payload, blocks: [{ id: 'a', kind: 'evil', span: 3, props: null }] } }) }); console.log('bad kind', r.status);
  plan = 'essencial'; invalidatePlan('u1');
  r = await fetch(base + '/share', { method: 'POST', headers: H, body: JSON.stringify({ title: 'x', payload }) }); console.log('create essencial', r.status, (await r.json() as any).error);
  r = await fetch(base + '/share/' + created.slug); console.log('public get after downgrade', r.status);
  plan = 'pro'; invalidatePlan('u1');
  r = await fetch(base + '/share/' + created.slug, { method: 'DELETE', headers: H }); console.log('revoke', r.status);
  r = await fetch(base + '/share/' + created.slug); console.log('public get after revoke', r.status);
  r = await fetch(base + '/share/..%2F..'); console.log('bad slug', r.status);
  process.exit(0);
}, 300);
