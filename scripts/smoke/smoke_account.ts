process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgres://postgres@localhost:55432/dash'; process.env.PG_SSL = 'false';
process.env.APP_URL = 'https://app.test'; process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'development';
process.env.PORT = '18791'; process.env.CORS_ORIGIN = 'https://app.test';
process.env.ASAAS_API_KEY = 'k'; process.env.ASAAS_WEBHOOK_TOKEN = 'wh'; process.env.JOBS_SECRET = 'js';
const B = require('path').resolve(__dirname, '../../src');
const asaas: any[] = []; const mails: string[] = []; let asaasFail = false;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (u: any, i: any) => {
  const s = String(u);
  if (s.includes('asaas.com')) {
    asaas.push([i.method, s.replace(/^.*\/v3/, '')]);
    if (asaasFail) return { ok: false, status: 500, text: async () => '{"errors":[{"description":"fora"}]}' };
    const out = s.includes('/payments?customer=') ? { data: [{ id: 'pay_9', value: 49.9, status: 'CONFIRMED', billingType: 'CREDIT_CARD', description: 'Plano pro (mensal)', dueDate: '2026-10-01', paymentDate: '2026-10-01', invoiceUrl: 'https://asaas.test/i/pay_9' }] } : { deleted: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  }
  if (s.includes('resend.com')) { mails.push(JSON.parse(i.body).subject); return { ok: true, status: 200, text: async () => '{}' }; }
  return realFetch(u, i);
};
process.env.RESEND_API_KEY = 're_test';
require(B + '/index');
const { pool } = require(B + '/db');
const { invalidatePlan } = require(B + '/auth/middleware');
const base = 'http://127.0.0.1:18791';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const cookieOf = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];
const J = (r: Response) => r.json() as Promise<any>;
const post = (p: string, body: any, h: any = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
setTimeout(async () => {
  try {
    await pool.query("delete from users where email like '%@acc.test'"); await pool.query("delete from billing_archive where asaas_customer_id = 'cus_9'");
    // Duas sessões (dois "dispositivos")
    let r = await post('/auth/signup', { email: 'b@acc.test', password: 'Senha-forte-123', full_name: 'Bia' }, { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130' });
    const s1: any = await J(r); const c1 = cookieOf(r); const id = s1.user.id;
    r = await post('/auth/login', { email: 'b@acc.test', password: 'Senha-forte-123' }, { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/17' });
    const s2: any = await J(r); const c2 = cookieOf(r);
    const H1 = { 'content-type': 'application/json', authorization: 'Bearer ' + s1.access_token };
    const H2 = { 'content-type': 'application/json', authorization: 'Bearer ' + s2.access_token };
    // refresh mantém a família
    r = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c1, 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/131' } });
    const rf: any = await J(r); const c1b = cookieOf(r);
    const Hr = { 'content-type': 'application/json', authorization: 'Bearer ' + rf.access_token };
    r = await fetch(base + '/me/sessions', { headers: Hr }); let ss: any = await J(r);
    ok(ss.sessions.length === 2 && ss.sessions.filter((x: any) => x.current).length === 1 && ss.sessions.some((x: any) => /Chrome\/131/.test(x.userAgent)), 'sessões: 2, atual marcada, UA atualizado na rotação ' + JSON.stringify(ss.sessions.map((x: any) => [x.current, (x.userAgent||'').slice(-10), x.ip])));
    // perfil
    r = await fetch(base + '/me', { method: 'PATCH', headers: H1, body: JSON.stringify({ fullName: '  Beatriz Lima ' }) });
    r = await fetch(base + '/me', { headers: H1 }); let me: any = await J(r);
    ok(me.fullName === 'Beatriz Lima' && !!me.createdAt && Array.isArray(me.waitlist), 'perfil: nome salvo, createdAt/waitlist no /me');
    // senha errada / fraca / certa
    r = await post('/me/password', { current: 'errada', next: 'Outra-senha-456' }, H2); ok(r.status === 403, 'senha atual errada 403');
    r = await post('/me/password', { current: 'Senha-forte-123', next: '123' }, H2); ok(r.status === 400, 'senha nova fraca 400 ' + r.status);
    r = await post('/me/password', { current: 'Senha-forte-123', next: 'Outra-senha-456' }, H2); let pw: any = await J(r);
    ok(r.status === 200 && pw.revoked === 1 && mails.includes('Sua senha foi alterada - Dash'), 'troca de senha encerra a outra sessão e avisa por e-mail ' + JSON.stringify(pw));
    r = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c1b } }); ok(r.status === 401, 'sessão 1 derrubada após troca');
    r = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c2 } }); ok(r.status === 200, 'sessão atual continua');
    const c2b = cookieOf(r);
    r = await post('/auth/login', { email: 'b@acc.test', password: 'Outra-senha-456' }); ok(r.status === 200, 'login com a nova senha');
    const s3: any = await J(r);
    // encerrar uma / outras
    r = await fetch(base + '/me/sessions', { headers: H2 }); ss = await J(r);
    const other = ss.sessions.find((x: any) => !x.current);
    r = await fetch(base + '/me/sessions/' + other.id, { method: 'DELETE', headers: H2 }); ok(r.status === 200, 'encerrar sessão específica');
    r = await fetch(base + '/me/sessions/' + other.id, { method: 'DELETE', headers: H2 }); ok(r.status === 404, 'encerrar de novo = 404');
    await post('/auth/login', { email: 'b@acc.test', password: 'Outra-senha-456' });
    r = await post('/me/sessions/revoke-others', {}, H2); const ro: any = await J(r);
    ok(ro.revoked === 1, 'encerrar as outras ' + JSON.stringify(ro));
    // reenviar verificação
    r = await post('/auth/resend-verification', {}, H2); ok(r.status === 200 && mails.filter(m => /Confirme/.test(m)).length >= 2, 'reenviar confirmação');
    // waitlist
    r = await post('/me/waitlist', { feature: 'workspace', source: 'account_view' }, H2); await post('/me/waitlist', { feature: 'workspace' }, H2);
    r = await fetch(base + '/me', { headers: H2 }); me = await J(r); ok(JSON.stringify(me.waitlist) === '["workspace"]', 'waitlist persistida e idempotente');
    // IA: histórico
    await pool.query("insert into ai_usage (user_id, created_at) values ($1, now()), ($1, now() - interval '40 days')", [id]);
    r = await fetch(base + '/me/ai-usage', { headers: H2 }); const au: any = await J(r);
    ok(au.months.length === 2 && au.recent.length === 2, 'histórico de IA por mês ' + JSON.stringify(au.months));
    // faturas: sem customer = local; com customer = asaas; asaas fora = local
    r = await fetch(base + '/billing/history', { headers: H2 }); let bh: any = await J(r); ok(bh.source === 'local' && bh.items.length === 0, 'faturas sem cliente Asaas');
    await pool.query(`begin; select set_config('app.billing','on',true); update profiles set plan='pro', asaas_customer_id='cus_9', asaas_subscription_id='sub_9', billing_method='card', auto_renew=true, current_period_end=now()+interval '20 days' where id='${id}'; commit;`);
    await pool.query("insert into billing_cycles (user_id, plan, billing_type, asaas_payment_id, value, due_date, period_start, period_end, status) values ($1,'pro','PIX','pay_pend',49.9,current_date,current_date,current_date+30,'PENDING'), ($1,'pro','PIX','pay_old',49.9,current_date-30,current_date-30,current_date,'PAID')", [id]);
    invalidatePlan(id);
    r = await fetch(base + '/billing/history', { headers: H2 }); bh = await J(r);
    ok(bh.source === 'asaas' && bh.items[0].invoiceUrl === 'https://asaas.test/i/pay_9' && bh.items[0].paidAt === '2026-10-01', 'faturas do Asaas com link');
    asaasFail = true; r = await fetch(base + '/billing/history', { headers: H2 }); bh = await J(r); ok(bh.source === 'local' && bh.items.length === 2, 'Asaas fora: ciclos locais');
    // exportar
    r = await fetch(base + '/me/export', { headers: H2 }); const ex: any = await J(r);
    ok(/attachment/.test(r.headers.get('content-disposition') || '') && ex.conta.email === 'b@acc.test' && ex.cobrancasPixBoleto.length === 2 && !('password_hash' in ex.conta), 'exportar dados (sem hash de senha)');
    // excluir: senha errada / sem EXCLUIR / Asaas fora → nada apagado
    r = await fetch(base + '/me', { method: 'DELETE', headers: H2, body: JSON.stringify({ password: 'x', confirm: 'EXCLUIR' }) }); ok(r.status === 403, 'excluir com senha errada 403');
    r = await fetch(base + '/me', { method: 'DELETE', headers: H2, body: JSON.stringify({ password: 'Outra-senha-456', confirm: 'sim' }) }); ok(r.status === 400, 'excluir sem EXCLUIR 400');
    r = await fetch(base + '/me', { method: 'DELETE', headers: H2, body: JSON.stringify({ password: 'Outra-senha-456', confirm: 'EXCLUIR' }) });
    let still = (await pool.query('select 1 from users where id=$1', [id])).rowCount;
    ok(r.status === 502 && still === 1, 'Asaas fora ao cancelar assinatura: conta não é apagada (' + r.status + ')');
    asaasFail = false; asaas.length = 0;
    r = await fetch(base + '/me', { method: 'DELETE', headers: H2, body: JSON.stringify({ password: 'Outra-senha-456', confirm: 'EXCLUIR' }) });
    still = (await pool.query('select 1 from users where id=$1', [id])).rowCount;
    const arch = (await pool.query("select asaas_customer_id, asaas_payment_id, status from billing_archive where asaas_customer_id='cus_9' order by asaas_payment_id")).rows;
    const left = (await pool.query('select (select count(*) from refresh_tokens where user_id=$1)::int + (select count(*) from ai_usage where user_id=$1)::int + (select count(*) from billing_cycles where user_id=$1)::int + (select count(*) from waitlist where user_id=$1)::int as n', [id])).rows[0].n;
    ok(r.status === 200 && still === 0 && left === 0, 'conta e dados apagados em cascata');
    ok(asaas.some(a => a[0] === 'DELETE' && a[1] === '/subscriptions/sub_9') && asaas.some(a => a[0] === 'DELETE' && a[1] === '/payments/pay_pend'), 'assinatura e cobrança pendente canceladas no Asaas ' + JSON.stringify(asaas));
    ok(arch.length === 2 && arch.find((a: any) => a.asaas_payment_id === 'pay_pend').status === 'CANCELED', 'cobranças arquivadas sem vínculo pessoal');
    ok(/dash_rt=;/.test(r.headers.get('set-cookie') || ''), 'cookie de sessão limpo');
    ok(mails.includes('Sua conta Dash foi excluida'), 'e-mail de confirmação da exclusão');
    r = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie: c2b } }); ok(r.status === 401, 'sessão não renova após exclusão');
    // rate limit do login
    let last = 0; for (let i = 0; i < 11; i++) { const x = await post('/auth/login', { email: 'rl@acc.test', password: 'x' }); last = x.status; }
    ok(last === 429, 'login limitado após 10 tentativas (' + last + ')');
    const other2 = await post('/auth/login', { email: 'outro@acc.test', password: 'x' }); ok(other2.status === 401, 'limite é por e-mail+IP');
  } catch (e) { console.error('ERRO', e); fails++; }
  console.log(fails ? fails + ' FALHAS' : 'TUDO OK');
  await pool.end().catch(() => {}); process.exit(fails ? 1 : 0);
}, 400);
