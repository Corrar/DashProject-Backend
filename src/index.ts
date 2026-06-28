import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './env';
import { errorHandler, log } from './lib';
import { webhookRouter } from './billing/webhook';
import authRoutes from './auth/routes';
import billingRoutes from './billing/routes';
import toolsRoutes from './tools/routes';
import accountRoutes from './account';
import jobsRoutes from './jobs/routes';

const app = express();
app.set('trust proxy', 1); // Render fica atrás de proxy — necessário p/ secure cookies e IP real.

app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true })); // origens exatas (não '*') p/ permitir credenciais

// Health — também serve de alvo p/ o keepalive (UptimeRobot) contra o spin-down do Render free.
app.get('/health', (_req, res) => { res.json({ ok: true }); });

// WEBHOOK ASAAS: valida token no header e parseia JSON próprio (sem HMAC/raw-body).
// Montado antes das demais rotas /billing; só responde a POST /billing/webhook.
app.use('/billing', webhookRouter());

app.use(cookieParser());
app.use('/auth', authRoutes);
app.use('/billing', billingRoutes);
app.use('/tools', toolsRoutes);
app.use('/jobs', jobsRoutes);
app.use('/', accountRoutes);

app.use((_req, res) => { res.status(404).json({ error: 'nao_encontrado' }); });
app.use(errorHandler);

const server = app.listen(env.port, () => log('info', 'api_no_ar', { port: env.port, env: env.nodeEnv }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
