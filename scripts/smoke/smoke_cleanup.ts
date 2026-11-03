process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgres://postgres@localhost:55432/dash'; process.env.PG_SSL = 'false';
process.env.APP_URL = 'https://app.test'; process.env.JWT_ACCESS_SECRET = 'secret'; process.env.NODE_ENV = 'development';
process.env.PORT = '18793'; process.env.CORS_ORIGIN = 'https://app.test'; process.env.JOBS_SECRET = 'js'; process.env.ASAAS_API_KEY = 'k';
require(require('path').resolve(__dirname, '../../src/index'));
const { pool } = require(require('path').resolve(__dirname, '../../src/db'));
setTimeout(async () => {
  const r = await fetch('http://127.0.0.1:18793/jobs/billing-tick', { method: 'POST', headers: { 'x-jobs-secret': 'js' } });
  console.log('tick', r.status, JSON.stringify(await r.json()));
  const q = await pool.query("select (select count(*) from refresh_tokens t join users u on u.id=t.user_id where u.email='keep@cleanup.test' and token_hash like 'old-%')::int old, (select count(*) from refresh_tokens t join users u on u.id=t.user_id where u.email='keep@cleanup.test' and token_hash like 'live-%')::int live, (select count(*) from email_tokens t join users u on u.id=t.user_id where u.email='keep@cleanup.test')::int mails");
  console.log(JSON.stringify(q.rows[0]));
  await pool.query("delete from users where email='keep@cleanup.test'"); await pool.end(); process.exit(0);
}, 400);
