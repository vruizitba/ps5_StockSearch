import type { Env } from '../types';
import type { AlertMessage, Channel, ChannelResult } from './types';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryable, sleep } from './types';

const RESEND_API = 'https://api.resend.com/emails';

export function recipients(env: Env): string[] {
  return (env.ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Manda a UN destinatario, con reintentos.
 *
 * Un pedido por destinatario a proposito. Resend valida la lista entera antes
 * de enviar: con un solo `to` de mas que no acepte, rechaza el pedido completo
 * con 422 y no le llega a NADIE. Verificado contra la API. Uno por uno, una
 * direccion rota solo se pierde a si misma.
 */
async function sendTo(env: Env, to: string, msg: AlertMessage): Promise<ChannelResult> {
  let last = 'sin intentos';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status = 0;
    try {
      const res = await fetch(RESEND_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [to],
          subject: msg.subject,
          html: msg.html,
        }),
      });
      status = res.status;
      if (res.ok) return { to, ok: true, detail: `HTTP ${status}` };
      last = `HTTP ${status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      last = `red: ${String(e).slice(0, 150)}`;
    }

    if (!retryable(status)) break;
    const wait = RETRY_DELAYS_MS[attempt - 1];
    if (wait !== undefined && attempt < MAX_ATTEMPTS) await sleep(wait);
  }

  console.error('resend fallo', to, last);
  return { to, ok: false, detail: last };
}

export const email: Channel = {
  name: 'email',
  configured: (env) => Boolean(env.RESEND_API_KEY) && recipients(env).length > 0,
  send: (env, msg) => Promise.all(recipients(env).map((r) => sendTo(env, r, msg))),
};
