import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL ausente'); process.exit(1); }

const pool = new Pool({
  connectionString: url,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: true },
});

async function main(): Promise<void> {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`-> aplicando ${f}\n`);
    await pool.query(sql);
  }
  await pool.end();
  process.stdout.write('OK migrations aplicadas\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
