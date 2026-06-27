import { env } from '../env';
import { log } from '../lib';

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!env.resendApiKey) {
    // Modo dev: sem provedor, loga o conteúdo p/ copiar o link manualmente.
    log('warn', 'email_nao_enviado_sem_resend', { to, subject, html });
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.emailFrom, to, subject, html }),
  });
  if (!r.ok) {
    const body = await r.text();
    log('error', 'resend_falhou', { status: r.status, body: body.slice(0, 300) });
    throw new Error('falha_envio_email');
  }
}

export async function sendVerifyEmail(to: string, link: string): Promise<void> {
  await send(
    to,
    'Confirme seu e-mail - Dash',
    `<p>Confirme seu e-mail para ativar a conta:</p>
     <p><a href="${link}">Confirmar e-mail</a></p>
     <p>O link expira em 24h.</p>`,
  );
}

export async function sendResetEmail(to: string, link: string): Promise<void> {
  await send(
    to,
    'Redefinir senha - Dash',
    `<p>Recebemos um pedido para redefinir sua senha:</p>
     <p><a href="${link}">Redefinir senha</a></p>
     <p>O link expira em 1h. Se nao foi voce, ignore este e-mail.</p>`,
  );
}
