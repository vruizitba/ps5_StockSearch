import type { Env, StockResult } from './types';
import type { StoreMeta } from './stores/index';

const RESEND_API = 'https://api.resend.com/emails';

function recipients(env: Env): string[] {
  return env.ALERT_EMAILS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function send(env: Env, subject: string, html: string): Promise<void> {
  const to = recipients(env);
  if (!env.RESEND_API_KEY || to.length === 0) return;

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    console.error('resend fallo', res.status, (await res.text()).slice(0, 300));
  }
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
): Promise<void> {
  const price = result.price ? ` - ${result.price}` : '';
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const indirect = store.direct
    ? ''
    : `<p style="color:#a15c00;font-size:14px">Dato indirecto via ${store.source}. ` +
      `Puede llegar con retraso respecto de la tienda.</p>`;

  await send(
    env,
    `PS5 Pro DISPONIBLE en ${store.name}${price}`,
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h1 style="font-size:24px;margin:0 0 8px">PS5 Pro disponible en ${store.name}</h1>
       <p style="font-size:20px;margin:0 0 20px"><strong>${result.price ?? 'precio no informado'}</strong></p>
       <p style="margin:0 0 28px"><a href="${store.url}" style="${BUTTON}">Ir a comprar</a></p>
       ${indirect}
       <p style="color:#666;font-size:13px;margin-top:24px">
         Detectado ${when} ET<br>Senal: ${result.detail ?? '-'}<br>${store.url}
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
): Promise<void> {
  await send(
    env,
    `Monitor PS5: ${store.name} sin datos hace ${minutes} min`,
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px">
       <h2>${store.name} no esta devolviendo estado</h2>
       <p>Estado: <strong>${result.status}</strong><br>Detalle: ${result.detail ?? '-'}</p>
       <p style="color:#666;font-size:14px">
         Esta tienda no se esta chequeando bien hace ${minutes} minutos. Mientras dure,
         no vas a recibir alertas de stock de ${store.name}. Las demas siguen funcionando.
       </p>
       <p style="color:#666;font-size:13px">Fuente: ${store.source}</p>
     </div>`,
  );
}

export async function sendTestEmail(env: Env): Promise<void> {
  await send(
    env,
    'Monitor PS5 Pro: prueba de correo',
    `<div style="font-family:system-ui,-apple-system,sans-serif">
       <h2>El correo funciona</h2>
       <p>Si estas leyendo esto, las alertas de stock van a llegar.</p>
       <p style="margin-top:24px"><a href="https://example.com" style="${BUTTON}">Asi se ve el boton</a></p>
     </div>`,
  );
}
