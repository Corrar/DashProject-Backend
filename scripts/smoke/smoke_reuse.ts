process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgres://postgres@localhost:55432/dash'; process.env.PG_SSL = 'false';
process.env.APP_URL = 'https://app.test'; process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'development';
process.env.PORT = '18792'; process.env.CORS_ORIGIN = 'https://app.test';
const B = require('path').resolve(__dirname, '../../src');
require(B + '/index');
const { pool } = require(B + '/db');
const base = 'http://127.0.0.1:18792';
let fails = 0; const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ck = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];
const post = (p: string, b: any, h: any = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
const refresh = (c: string) => fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c } });
setTimeout(async () => {
  try {
    await pool.query("delete from users where email like '%@reuse.test'");
    let r = await post('/auth/signup', { email: 'r@reuse.test', password: 'Senha-forte-123' }); const a1 = ck(r);
    r = await post('/auth/login', { email: 'r@reuse.test', password: 'Senha-forte-123' }); const b1 = ck(r);
    r = await refresh(a1); const a2 = ck(r); ok(r.status === 200, 'rotação normal');
    r = await refresh(a1); const e: any = await r.json(); ok(r.status === 401 && e.error === 'refresh_reutilizado', 'reuso de token rotacionado detectado');
    r = await refresh(a2); ok(r.status === 401, 'família comprometida derrubada');
    r = await refresh(b1); ok(r.status === 200, 'outra sessão do usuário segue viva');
    const b2 = ck(r);
    r = await post('/auth/logout', {}, { cookie: b2 });
    r = await refresh(b2); const e2: any = await r.json(); ok(r.status === 401 && e2.error === 'sessao_encerrada', 'token de logout: 401 sem efeito colateral');
  } catch (e) { console.error(e); fails++; }
  console.log(fails ? fails + ' FALHAS' : 'TUDO OK'); await pool.end().catch(() => {}); process.exit(fails ? 1 : 0);
}, 400);
