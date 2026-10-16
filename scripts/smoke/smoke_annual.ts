process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgres://postgres@localhost:55432/dash'; process.env.PG_SSL = 'false';
process.env.APP_URL = 'https://app.test'; process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'development';
process.env.PORT = '18790'; process.env.CORS_ORIGIN = 'https://app.test';
process.env.ASAAS_API_KEY = 'k'; process.env.ASAAS_WEBHOOK_TOKEN = 'wh'; process.env.JOBS_SECRET = 'js'; process.env.GEMINI_API_KEY = 'g';
const B = require('path').resolve(__dirname, '../../src');
const RUNID = Date.now(); const asaas: any[] = []; let chk = 0;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (u: any, i: any) => {
  const s = String(u);
  if (s.includes('asaas.com')) {
    const body = i.body ? JSON.parse(i.body) : null; asaas.push([i.method, s.replace(/^.*\/v3/, ''), body]);
    const out = s.endsWith('/checkouts') ? { id: 'chk_' + RUNID + '_' + (++chk), link: 'https://asaas.test/c/' + chk } : s.endsWith('/payments') ? { id: 'pay_job', invoiceUrl: 'https://asaas.test/i' } : { id: 'sub_1', deleted: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  }
  if (s.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Narrativa teste' }] } }] }) };
  if (s.includes('resend.com')) return { ok: true, status: 200, text: async () => '{}' };
  return realFetch(u, i);
};
require(B + '/index');
const { pool } = require(B + '/db');
const { invalidatePlan } = require(B + '/auth/middleware');
const base = 'http://127.0.0.1:18790'; const RUN = Date.now();
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const prof = async (id: string) => (await pool.query('select plan, billing_method, billing_cycle, auto_renew, current_period_end, asaas_subscription_id from profiles where id=$1', [id])).rows[0];
const hook = (evt: any) => fetch(base + '/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'wh' }, body: JSON.stringify(evt) });
setTimeout(async () => {
  try {
    await pool.query("delete from users where email like '%@smoke.test'");
    let r = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@smoke.test', password: 'Senha-forte-123' }) });
    const su: any = await r.json(); const id = su.user?.id; const H = { 'content-type': 'application/json', authorization: 'Bearer ' + su.access_token };
    ok(r.status === 201 && !!id, 'signup ' + r.status);
    // Free: 1 IA/mês
    const ai = () => fetch(base + '/tools/analyze', { method: 'POST', headers: H, body: JSON.stringify({ columns: [{ name: 'a' }], sampleRows: [{ a: 1 }] }) });
    r = await ai(); ok(r.status === 200, 'free 1a analise 200 (' + r.status + ')');
    r = await ai(); const q: any = await r.json(); ok(r.status === 429 && q.limite === 1 && q.usados === 1, 'free 2a analise 429 ' + JSON.stringify(q));
    r = await fetch(base + '/me', { headers: H }); let me: any = await r.json();
    ok(me.plan === 'free' && me.billingCycle === null && me.autoRenew === null, '/me free ' + JSON.stringify({ plan: me.plan, limits: me.limits, aiUsed: me.aiUsed ?? me.usage }));
    r = await fetch(base + '/tools/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); ok(r.status === 401, 'anonimo analyze 401');
    // Checkout anual cartão Pro
    r = await fetch(base + '/billing/checkout', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', method: 'card', cycle: 'yearly' }) });
    let c = asaas.pop(); ok(r.status === 200 && c[2].subscription.cycle === 'YEARLY' && c[2].items[0].value === 499, 'checkout anual card ' + JSON.stringify(c[2].items[0]) + ' ' + c[2].subscription.cycle);
    const sess = (await pool.query('select cycle, plan from checkout_sessions where checkout_id=$1', ['chk_' + RUNID + '_' + chk])).rows[0]; ok(sess.cycle === 'yearly', 'sessao grava cycle');
    // Webhook pagamento 499 -> pro anual, +365d
    r = await hook({ id: 'evt_a1_' + RUN, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_a1_' + RUN, subscription: 'sub_1', checkoutSession: 'chk_' + RUNID + '_' + chk, value: 499, billingType: 'CREDIT_CARD', customer: 'cus_1' } });
    let p = await prof(id); const days = Math.round((new Date(p.current_period_end).getTime() - Date.now()) / 864e5);
    ok(r.status === 200 && p.plan === 'pro' && p.billing_cycle === 'yearly' && p.auto_renew === true && days >= 364 && days <= 366, 'ativacao anual ' + JSON.stringify({ plan: p.plan, cycle: p.billing_cycle, days }));
    invalidatePlan(id);
    r = await fetch(base + '/me', { headers: H }); me = await r.json(); ok(me.billingCycle === 'yearly' && me.autoRenew === true, '/me anual');
    // Checkout repetido pro anual -> 409; mensal com cartão ativo -> 409 assinatura_ativa
    r = await fetch(base + '/billing/checkout', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', cycle: 'yearly' }) }); ok(r.status === 409 && (await r.json() as any).error === 'plano_ja_ativo', 'checkout mesmo plano/ciclo 409');
    r = await fetch(base + '/billing/checkout', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', cycle: 'monthly' }) }); ok(r.status === 409, 'checkout com cartao ativo 409 ' + (await r.json() as any).error);
    // change-plan: anual->mensal no mesmo tier
    r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', cycle: 'monthly' }) });
    c = asaas.pop(); ok(r.status === 200 && c[2].cycle === 'MONTHLY' && c[2].value === 49.9, 'change-plan ciclo ' + r.status + ' ' + JSON.stringify(c[2]));
    r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', cycle: 'yearly' }) });
    c = asaas.pop(); ok(r.status === 200 && c[2].value === 499, 'change-plan volta anual');
    // Cancelamento: mantém acesso até o fim do período
    r = await fetch(base + '/billing/cancel', { method: 'POST', headers: H }); const cj: any = await r.json();
    ok(r.status === 200 && !!cj.accessUntil, 'cancel accessUntil ' + cj.accessUntil);
    r = await hook({ id: 'evt_a2_' + RUN, event: 'SUBSCRIPTION_DELETED', subscription: { id: 'sub_1', customer: 'cus_1' } });
    p = await prof(id); ok(p.plan === 'pro' && p.auto_renew === false, 'SUB_END com periodo mantem pro ' + JSON.stringify({ plan: p.plan, ar: p.auto_renew }));
    invalidatePlan(id);
    r = await fetch(base + '/billing/change-plan', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'essencial' }) }); ok(r.status === 409 && (await r.json() as any).error === 'assinatura_cancelada', 'change-plan apos cancelar 409');
    // Reassinar enquanto cancelado: liberado
    r = await fetch(base + '/billing/checkout', { method: 'POST', headers: H, body: JSON.stringify({ plan: 'pro', cycle: 'monthly' }) }); ok(r.status === 200, 'reassinar com auto_renew=false 200');
    // Job: ainda no período -> não derruba
    const tick = async () => { const t = await fetch(base + '/jobs/billing-tick', { method: 'POST', headers: { 'x-jobs-secret': 'js' } }); return [t.status, await t.json()]; };
    let t = await tick(); p = await prof(id); ok(p.plan === 'pro', 'job no periodo mantem pro ' + JSON.stringify(t));
    // Período acabou (+grace) -> job derruba
    await pool.query("begin; select set_config('app.billing','on',true); update profiles set current_period_end = now() - interval '30 days' where id=$1; commit;".replace('$1', `'${id}'`));
    t = await tick(); p = await prof(id); ok(p.plan === 'free', 'job pos-periodo derruba ' + JSON.stringify(t));
    // SUB_END sem período restante -> free na hora
    await pool.query(`begin; select set_config('app.billing','on',true); update profiles set plan='essencial', auto_renew=true, billing_method='card', asaas_subscription_id='sub_2', current_period_end=now() - interval '1 day' where id='${id}'; commit;`);
    await hook({ id: 'evt_a3_' + RUN, event: 'SUBSCRIPTION_INACTIVATED', subscription: { id: 'sub_2' } });
    p = await prof(id); ok(p.plan === 'free', 'SUB_END sem periodo -> free');
    // Pix anual: renovação do job usa 299 e +365
    await pool.query(`begin; select set_config('app.billing','on',true); update profiles set plan='essencial', billing_cycle='yearly', auto_renew=true, billing_method='pix', asaas_customer_id='cus_2', asaas_subscription_id=null, current_period_end=now() + interval '2 days' where id='${id}'; commit;`);
    asaas.length = 0; t = await tick();
    const pay = asaas.find((a) => a[1] === '/payments');
    ok(!!pay && pay[2].value === 299, 'renovacao pix anual 299 ' + JSON.stringify(pay?.[2]?.value) + ' ' + JSON.stringify(t));
    const bc = (await pool.query('select period_start, period_end from billing_cycles where user_id=$1 order by created_at desc limit 1', [id])).rows[0];
    ok(bc && Math.round((new Date(bc.period_end).getTime() - new Date(bc.period_start).getTime()) / 864e5) === 365, 'ciclo pix anual 365d ' + JSON.stringify(bc));
    // Webhook Pix anual: valor 299 -> essencial anual
    r = await hook({ id: 'evt_a4_' + RUN, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_job', value: 299, billingType: 'PIX', customer: 'cus_2', externalReference: id } });
    p = await prof(id); ok(p.plan === 'essencial' && p.billing_cycle === 'yearly', 'webhook pix anual ' + JSON.stringify({ plan: p.plan, c: p.billing_cycle, st: r.status }));
  } catch (e) { console.error('ERRO', e); process.exitCode = 1; }
  await pool.end().catch(() => {}); process.exit(process.exitCode ?? 0);
}, 400);
