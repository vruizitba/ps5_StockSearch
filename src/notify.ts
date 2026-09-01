import type { Env, StockResult } from './types';
import type { StoreMeta } from './stores/index';

const RESEND_API = 'https://api.resend.com/emails';

/** Intentos por destinatario antes de darlo por perdido. */
const MAX_ATTEMPTS = 3;
/** Espera entre intentos, en ms. Un elemento por reintento. */
const RETRY_DELAYS_MS = [600, 1800];

export interface SendOutcome {
  /** true si al menos un destinatario acepto el mail. */
  ok: boolean;
  delivered: string[];
  failed: Array<{ to: string; detail: string }>;
}

export function recipients(env: Env): string[] {
  return (env.ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Evita que un precio o un detalle con `<` rompa el HTML del mail. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Un 4xx no se reintenta: la key es invalida, el remitente no esta verificado o
 * la direccion es rechazada, y repetir da el mismo error. 408 y 429 si, porque
 * son transitorios, igual que cualquier 5xx o un fallo de red.
 */
function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Manda a UN destinatario, con reintentos.
 *
 * Se manda un pedido por destinatario a proposito. Resend valida la lista
 * entera antes de enviar: con un solo `to` de mas que no acepte, rechaza el
 * pedido completo con 422 y no le llega a NADIE. Verificado contra la API. Uno
 * por uno, una direccion rota solo se pierde a si misma.
 */
async function sendTo(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; detail: string }> {
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
        body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html }),
      });
      status = res.status;
      if (res.ok) return { ok: true, detail: `HTTP ${status}` };
      last = `HTTP ${status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      last = `red: ${String(e).slice(0, 150)}`;
    }

    if (!retryable(status)) break;
    const wait = RETRY_DELAYS_MS[attempt - 1];
    if (wait !== undefined && attempt < MAX_ATTEMPTS) await sleep(wait);
  }

  console.error('resend fallo', to, last);
  return { ok: false, detail: last };
}

/**
 * Manda a todos los destinatarios y devuelve que paso con cada uno.
 *
 * No lanza: el resultado se devuelve para que quien llama decida. Lo que si
 * hace es decir la verdad — antes esta funcion se tragaba los errores y la app
 * reportaba "enviado" aunque Resend hubiera rechazado el mail.
 */
export async function send(env: Env, subject: string, html: string): Promise<SendOutcome> {
  const to = recipients(env);

  if (!env.RESEND_API_KEY) {
    return { ok: false, delivered: [], failed: [{ to: '-', detail: 'falta RESEND_API_KEY' }] };
  }
  if (to.length === 0) {
    return { ok: false, delivered: [], failed: [{ to: '-', detail: 'ALERT_EMAILS vacio' }] };
  }

  const results = await Promise.all(
    to.map(async (addr) => ({ addr, ...(await sendTo(env, addr, subject, html)) })),
  );

  const delivered = results.filter((r) => r.ok).map((r) => r.addr);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ to: r.addr, detail: r.detail }));

  return { ok: delivered.length > 0, delivered, failed };
}

const BUTTON =
  'display:inline-block;padding:16px 32px;background:#0070f3;color:#fff;' +
  'text-decoration:none;border-radius:8px;font-size:18px;font-weight:600';

/**
 * Alerta de stock. Se lee en el celular durante un drop que dura minutos, asi
 * que lo importante va arriba y el link es un boton grande, tocable de una.
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

  return send(
    env,
    `PS5 Pro DISPONIBLE en ${store.name}${price}`,
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h1 style="font-size:24px;margin:0 0 8px">PS5 Pro disponible en ${esc(store.name)}</h1>
       <p style="font-size:20px;margin:0 0 20px"><strong>${esc(result.price ?? 'precio no informado')}</strong></p>
       <p style="margin:0 0 28px"><a href="${esc(store.url)}" style="${BUTTON}">Ir a comprar</a></p>
       ${indirect}
       <p style="color:#666;font-size:13px;margin-top:24px">
         Detectado ${esc(when)} ET<br>Senal: ${esc(result.detail ?? '-')}<br>${esc(store.url)}
       </p>
     </div>`,
  );
}

/**
 * Aviso de fuente rota.
 *
 * Es la contraparte de distinguir BLOCKED de OUT_OF_STOCK: sin este mail, una
 * tienda que quedo ciega se ve igual que una tienda sin stock, y el silencio
 * se confunde con "todavia no hay".
 */
export async function alertUnhealthy(
  env: Env,
  store: StoreMeta,
  result: StockResult,
  minutes: number,
): Promise<SendOutcome> {
  return send(
    env,
    `Monitor PS5: ${store.name} sin datos hace ${minutes} min`,
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h2>${esc(store.name)} no esta devolviendo estado</h2>
       <p>Estado: <strong>${esc(result.status)}</strong><br>Detalle: ${esc(result.detail ?? '-')}</p>
       <p style="color:#666;font-size:14px">
         Esta tienda no se esta chequeando bien hace ${minutes} minutos. Mientras dure,
         no vas a recibir alertas de stock de ${esc(store.name)}. Las demas siguen funcionando.
       </p>
       <p style="color:#666;font-size:13px">Fuente: ${esc(store.source)}</p>
     </div>`,
  );
}

/**
 * Aviso de que el reloj se salteo ticks.
 *
 * Si la cadena de alarmas se corta, el monitor no falla: deja de mirar, en
 * silencio. Cuando vuelve, este mail dice cuanto tiempo estuvo ciego.
 */
export async function alertClockGap(env: Env, gapMin: number): Promise<SendOutcome> {
  return send(
    env,
    `Monitor PS5: el reloj se detuvo ${gapMin} min`,
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h2>El monitor estuvo ${gapMin} minutos sin chequear</h2>
       <p>La cadena de alarmas se corto y se volvio a armar sola. Durante esa
          ventana no se miro ninguna tienda: si hubo stock, no llego alerta.</p>
       <p style="color:#666;font-size:13px">Ya volvio a correr cada minuto.</p>
     </div>`,
  );
}

export async function sendTestEmail(env: Env): Promise<SendOutcome> {
  return send(
    env,
    'Monitor PS5 Pro: prueba de correo',
    `<div style="font-family:system-ui,-apple-system,sans-serif">
       <h2>El correo funciona</h2>
       <p>Si estas leyendo esto, las alertas de stock van a llegar.</p>
       <p style="margin-top:24px"><a href="https://example.com" style="${BUTTON}">Asi se ve el boton</a></p>
     </div>`,
  );
}
