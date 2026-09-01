import type { Env, StockResult } from './types';
import type { StoreMeta } from './stores/index';
import type { AlertMessage, Channel } from './channels/types';
import { esc } from './channels/types';
import { email, recipients } from './channels/email';
import { telegram } from './channels/telegram';

export { esc, recipients };

/** Todos los canales conocidos. Los que no esten configurados se saltean. */
const CHANNELS: Channel[] = [email, telegram];

/** Nombres de los canales que hoy podrian entregar una alerta. */
export function activeChannels(env: Env): string[] {
  return CHANNELS.filter((c) => c.configured(env)).map((c) => c.name);
}

export interface SendOutcome {
  /** true si AL MENOS UN destino, en cualquier canal, acepto el mensaje. */
  ok: boolean;
  delivered: string[];
  failed: Array<{ to: string; detail: string }>;
  /** Canales que estaban configurados y se intentaron. */
  channels: string[];
}

/**
 * Manda por todos los canales configurados y devuelve que paso con cada destino.
 *
 * No lanza: el resultado se devuelve para que quien llama decida. Un canal caido
 * no impide que el otro entregue, y `ok` solo es false si fallaron todos — que
 * es cuando la alerta hay que reintentarla.
 */
export async function send(env: Env, msg: AlertMessage): Promise<SendOutcome> {
  const active = CHANNELS.filter((c) => c.configured(env));

  if (active.length === 0) {
    return {
      ok: false,
      delivered: [],
      failed: [{ to: '-', detail: 'ningun canal configurado' }],
      channels: [],
    };
  }

  // allSettled: que un canal explote no puede impedir que el otro entregue.
  const settled = await Promise.allSettled(active.map((c) => c.send(env, msg)));

  const delivered: string[] = [];
  const failed: Array<{ to: string; detail: string }> = [];

  settled.forEach((res, i) => {
    const name = active[i]!.name;
    if (res.status === 'rejected') {
      failed.push({ to: name, detail: `excepcion: ${String(res.reason).slice(0, 150)}` });
      return;
    }
    for (const r of res.value) {
      if (r.ok) delivered.push(r.to);
      else failed.push({ to: r.to, detail: r.detail });
    }
  });

  return { ok: delivered.length > 0, delivered, failed, channels: active.map((c) => c.name) };
}

const BUTTON =
  'display:inline-block;padding:16px 32px;background:#0070f3;color:#fff;' +
  'text-decoration:none;border-radius:8px;font-size:18px;font-weight:600';

/**
 * Alerta de stock. Se lee en el celular durante un drop que dura minutos, asi
 * que lo importante va arriba y el link es lo primero tocable.
 */
export async function alertInStock(
  env: Env,
  store: StoreMeta,
  result: StockResult,
): Promise<SendOutcome> {
  const price = result.price ? ` - ${result.price}` : '';
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const indirect = store.direct
    ? ''
    : `<p style="color:#a15c00;font-size:14px">Dato indirecto via ${esc(store.source)}. ` +
      `Puede llegar con retraso respecto de la tienda.</p>`;
  const avisoIndirecto = store.direct
    ? ''
    : `\n\n<i>Dato indirecto via ${esc(store.source)}: puede llegar con retraso.</i>`;

  return send(env, {
    subject: `PS5 Pro DISPONIBLE en ${store.name}${price}`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h1 style="font-size:24px;margin:0 0 8px">PS5 Pro disponible en ${esc(store.name)}</h1>
       <p style="font-size:20px;margin:0 0 20px"><strong>${esc(result.price ?? 'precio no informado')}</strong></p>
       <p style="margin:0 0 28px"><a href="${esc(store.url)}" style="${BUTTON}">Ir a comprar</a></p>
       ${indirect}
       <p style="color:#666;font-size:13px;margin-top:24px">
         Detectado ${esc(when)} ET<br>Senal: ${esc(result.detail ?? '-')}<br>${esc(store.url)}
       </p>
     </div>`,
    text:
      `🎮 <b>PS5 Pro DISPONIBLE en ${esc(store.name)}</b>\n` +
      `${esc(result.price ?? 'precio no informado')}\n\n` +
      `<a href="${esc(store.url)}">IR A COMPRAR</a>` +
      avisoIndirecto +
      `\n\n<code>${esc(result.detail ?? '-')}</code>`,
  });
}

/**
 * Aviso de fuente rota.
 *
 * Es la contraparte de distinguir BLOCKED de OUT_OF_STOCK: sin este mensaje, una
 * tienda que quedo ciega se ve igual que una tienda sin stock, y el silencio se
 * confunde con "todavia no hay".
 */
export async function alertUnhealthy(
  env: Env,
  store: StoreMeta,
  result: StockResult,
  minutes: number,
): Promise<SendOutcome> {
  return send(env, {
    subject: `Monitor PS5: ${store.name} sin datos hace ${minutes} min`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h2>${esc(store.name)} no esta devolviendo estado</h2>
       <p>Estado: <strong>${esc(result.status)}</strong><br>Detalle: ${esc(result.detail ?? '-')}</p>
       <p style="color:#666;font-size:14px">
         Esta tienda no se esta chequeando bien hace ${minutes} minutos. Mientras dure,
         no vas a recibir alertas de stock de ${esc(store.name)}. Las demas siguen funcionando.
       </p>
       <p style="color:#666;font-size:13px">Fuente: ${esc(store.source)}</p>
     </div>`,
    text:
      `⚠️ <b>${esc(store.name)} sin datos hace ${minutes} min</b>\n\n` +
      `Estado: ${esc(result.status)}\n${esc(result.detail ?? '-')}\n\n` +
      `Mientras dure no vas a recibir alertas de stock de esa tienda. Las demas siguen.`,
  });
}

/**
 * Aviso de que el reloj se salteo ticks.
 *
 * Si la cadena de alarmas se corta, el monitor no falla: deja de mirar, en
 * silencio. Cuando vuelve, este aviso dice cuanto tiempo estuvo ciego.
 */
export async function alertClockGap(env: Env, gapMin: number): Promise<SendOutcome> {
  return send(env, {
    subject: `Monitor PS5: el reloj se detuvo ${gapMin} min`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h2>El monitor estuvo ${gapMin} minutos sin chequear</h2>
       <p>La cadena de alarmas se corto y se volvio a armar sola. Durante esa
          ventana no se miro ninguna tienda: si hubo stock, no llego alerta.</p>
       <p style="color:#666;font-size:13px">Ya volvio a correr cada minuto.</p>
     </div>`,
    text:
      `⏱ <b>El monitor estuvo ${gapMin} min sin chequear</b>\n\n` +
      `La cadena de alarmas se corto y se rearmo sola. En esa ventana no se miro ` +
      `ninguna tienda. Ya volvio a correr cada minuto.`,
  });
}

export async function sendTestEmail(env: Env): Promise<SendOutcome> {
  return send(env, {
    subject: 'Monitor PS5 Pro: prueba de aviso',
    html: `<div style="font-family:system-ui,-apple-system,sans-serif">
       <h2>El aviso funciona</h2>
       <p>Si estas leyendo esto, las alertas de stock van a llegar.</p>
       <p style="margin-top:24px"><a href="https://example.com" style="${BUTTON}">Asi se ve el boton</a></p>
     </div>`,
    text: `✅ <b>El aviso funciona</b>\n\nSi estas leyendo esto, las alertas de stock van a llegar por aca.`,
  });
}
