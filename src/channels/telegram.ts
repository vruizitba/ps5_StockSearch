import type { Env } from '../types';
import type { AlertMessage, Channel, ChannelResult } from './types';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryable, sleep } from './types';

/**
 * Telegram como segundo canal.
 *
 * Su ventaja sobre el correo no es solo la redundancia: un push llega en un
 * segundo y suena, mientras que un mail puede quedar unos minutos en cola. Un
 * drop dura minutos, asi que esa diferencia importa.
 *
 * No necesita plantillas aprobadas ni ventana de conversacion —a diferencia de
 * WhatsApp—, pero si exige que el usuario le haya escrito al bot primero: un bot
 * no puede iniciar una conversacion.
 */
const API = 'https://api.telegram.org';

function chats(env: Env): string[] {
  return (env.TELEGRAM_CHAT_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendTo(env: Env, chatId: string, msg: AlertMessage): Promise<ChannelResult> {
  let last = 'sin intentos';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status = 0;
    try {
      const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg.text,
          parse_mode: 'HTML',
          // El link del producto es lo que se toca en un drop: la vista previa
          // lo empuja fuera de la pantalla.
          disable_web_page_preview: true,
        }),
      });
      status = res.status;
      if (res.ok) return { to: `telegram:${chatId}`, ok: true, detail: `HTTP ${status}` };
      last = `HTTP ${status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      last = `red: ${String(e).slice(0, 150)}`;
    }

    if (!retryable(status)) break;
    const wait = RETRY_DELAYS_MS[attempt - 1];
    if (wait !== undefined && attempt < MAX_ATTEMPTS) await sleep(wait);
  }

  console.error('telegram fallo', chatId, last);
  return { to: `telegram:${chatId}`, ok: false, detail: last };
}

export const telegram: Channel = {
  name: 'telegram',
  configured: (env) => Boolean(env.TELEGRAM_BOT_TOKEN) && chats(env).length > 0,
  send: (env, msg) => Promise.all(chats(env).map((c) => sendTo(env, c, msg))),
};
