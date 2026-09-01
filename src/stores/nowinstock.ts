import type { StockResult } from '../types';
import { BROWSER_HEADERS, fetchWithTimeout, looksBlocked } from './detect';

/**
 * nowinstock.net como respaldo para Newegg.
 *
 * La API ProductRealtime de Newegg responde a un pedido desde una conexion
 * residencial pero devuelve 403 a las IPs de Cloudflare, asi que en produccion
 * la via directa no sirve. nowinstock ya monitorea la PS5 Pro en Newegg y
 * publica el estado en HTML plano, y su sitio si responde desde Cloudflare.
 *
 * Mismo criterio que hotstock: es un tercero, con su propia latencia, y la
 * tienda queda marcada como indirecta.
 */
const URL_NIS = 'https://www.nowinstock.net/videogaming/consoles/sonyps5/';
const CACHE_TTL_MS = 150_000;

type Snapshot = { at: number; rows: Map<string, boolean> } | { at: number; err: string };

let cache: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

async function parse(res: Response): Promise<Map<string, boolean>> {
  const rows = new Map<string, boolean>();
  let label: string | null = null;
  let capturing = false;

  await new HTMLRewriter()
    // Cada fila arranca de cero: la etiqueta esta en el primer <td>, el estado
    // en el segundo, y sin reiniciar se cruzarian filas vecinas.
    .on('tr', {
      element() {
        label = null;
        capturing = true;
      },
    })
    .on('td a', {
      text(t) {
        if (!capturing) return;
        label = (label ?? '') + t.text;
      },
    })
    .on('td[class*="stockStatus"]', {
      element(el) {
        if (!label) return;
        const cls = el.getAttribute('class') ?? '';
        rows.set(label.trim(), cls.includes('stockStatusIn') || cls.includes('stockStatusAvailable'));
        capturing = false; // el resto de la fila ya no aporta etiqueta
      },
    })
    .transform(res)
    .arrayBuffer();

  return rows;
}

async function load(): Promise<Snapshot> {
  try {
    const res = await fetchWithTimeout(URL_NIS, { headers: BROWSER_HEADERS }, 12_000);
    if (looksBlocked(res.status, '') || !res.ok) {
      return { at: Date.now(), err: `HTTP ${res.status}` };
    }
    const rows = await parse(res);
    if (rows.size === 0) return { at: Date.now(), err: 'no se parseo ninguna fila' };
    return { at: Date.now(), rows };
  } catch (e) {
    return { at: Date.now(), err: `fetch fallo: ${String(e).slice(0, 100)}` };
  }
}

async function snapshot(): Promise<Snapshot> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = load().then((s) => {
    cache = s;
    inFlight = null;
    return s;
  });
  return inFlight;
}

/** `rowLabel` debe coincidir con el texto del primer td, ej "Console: Pro 2TB : Newegg". */
export async function checkViaNowInStock(rowLabel: string): Promise<StockResult> {
  const snap = await snapshot();
  if ('err' in snap) return { status: 'ERROR', detail: `nowinstock: ${snap.err}` };

  const inStock = snap.rows.get(rowLabel);
  if (inStock === undefined) {
    return { status: 'ERROR', detail: `nowinstock ya no lista "${rowLabel}"` };
  }

  const ageSec = Math.round((Date.now() - snap.at) / 1000);
  return {
    status: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    detail: `via nowinstock (cache ${ageSec}s)`,
  };
}
