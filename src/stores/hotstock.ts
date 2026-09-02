import type { StockResult } from '../types';
import { BROWSER_HEADERS, fetchWithTimeout, looksBlocked } from './detect';

/**
 * hotstock.io como fuente para las tiendas que no podemos consultar directo.
 *
 * Walmart, Target y GameStop devuelven muros anti-bot a un fetch plano, y el
 * buybox de Amazon lo arma JavaScript, asi que parsear su HTML da falsos
 * positivos. hotstock ya monitorea las cuatro y publica el estado en HTML
 * server-renderizado, sin muro.
 *
 * Contrapartida honesta: es un tercero. No controlamos su frecuencia ni su
 * continuidad, y la latencia real es la de ellos mas la nuestra. Por eso estas
 * tiendas se marcan como indirectas en el dashboard.
 *
 * Se consulta una sola vez por ciclo y se cachea: son un servicio chico y
 * pegarle una vez por tienda por minuto seria abusivo.
 */
// Con www: sin el, hotstock responde 301 y cada chequeo paga un salto de mas.
const URL_HOTSTOCK = 'https://www.hotstock.io/us/p/playstation-5-pro-console-2tb';
/** Cache de un resultado bueno. Una consulta por minuto es cortes y suficiente. */
const CACHE_TTL_MS = 55_000;
/**
 * Cache de un error, mucho mas corta.
 *
 * Un fallo transitorio se cacheaba igual que un exito y dejaba a las cuatro
 * tiendas indirectas ciegas dos minutos y medio. Reintentar a los 20 segundos
 * cuesta poco y recorta la ventana en la que no se esta mirando nada.
 */
const ERROR_TTL_MS = 20_000;

export interface HotstockEntry {
  inStock: boolean;
}

// No hay campo de precio a proposito: hotstock no publica ninguno, verificado
// sobre el HTML real de las seis filas. El campo existia declarado y sin asignar
// nunca, lo que sugeria una fuente de precios que no existe.

type Snapshot = { at: number; rows: Map<string, HotstockEntry> } | { at: number; err: string };

let cache: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

async function parse(res: Response): Promise<Map<string, HotstockEntry>> {
  const rows = new Map<string, HotstockEntry>();
  let currentShop: string | null = null;

  // HTMLRewriter parsea en streaming del lado de Rust. Sobre 140 KB de HTML es
  // la unica opcion que entra en los 10 ms de CPU del plan gratuito.
  await new HTMLRewriter()
    .on('h5.text-cell-shopname', {
      // Un nombre nuevo cierra el anterior. Si una fila no trae boton, sin este
      // reset el nombre viejo se pegaba al siguiente ("AmazonBest Buy") y la
      // tienda pasaba a reportar ERROR por no encontrarse en el mapa.
      element() {
        currentShop = null;
      },
      text(t) {
        const v = t.text.trim();
        if (v) currentShop = (currentShop ?? '') + v;
        if (t.lastInTextNode && currentShop) {
          rows.set(currentShop, { inStock: false });
        }
      },
    })
    .on('td.stock-cell button', {
      element(el) {
        if (!currentShop) return;
        const cls = el.getAttribute('class') ?? '';
        rows.set(currentShop, { inStock: cls.includes('button-instock') });
        currentShop = null; // la fila termino
      },
    })
    .transform(res)
    .arrayBuffer();

  return rows;
}

async function load(): Promise<Snapshot> {
  try {
    const res = await fetchWithTimeout(URL_HOTSTOCK, { headers: BROWSER_HEADERS }, 12_000);
    if (looksBlocked(res.status, '') || !res.ok) {
      return { at: Date.now(), err: `HTTP ${res.status}` };
    }
    const rows = await parse(res);
    if (rows.size === 0) {
      // El sitio cambio de estructura. Es ERROR, nunca "sin stock".
      return { at: Date.now(), err: 'no se parseo ninguna fila' };
    }
    return { at: Date.now(), rows };
  } catch (e) {
    return { at: Date.now(), err: `fetch fallo: ${String(e).slice(0, 100)}` };
  }
}

async function snapshot(): Promise<Snapshot> {
  const now = Date.now();
  const ttl = cache && 'err' in cache ? ERROR_TTL_MS : CACHE_TTL_MS;
  if (cache && now - cache.at < ttl) return cache;
  if (inFlight) return inFlight;
  inFlight = load().then((s) => {
    cache = s;
    inFlight = null;
    return s;
  });
  return inFlight;
}

/** `shopName` debe coincidir exactamente con el nombre que muestra hotstock. */
export async function checkViaHotstock(shopName: string): Promise<StockResult> {
  const snap = await snapshot();
  if ('err' in snap) return { status: 'ERROR', detail: `hotstock: ${snap.err}` };

  const entry = snap.rows.get(shopName);
  if (!entry) {
    // hotstock dejo de listar esa tienda. Avisar, no asumir que no hay stock.
    return { status: 'ERROR', detail: `hotstock ya no lista "${shopName}"` };
  }

  const ageSec = Math.round((Date.now() - snap.at) / 1000);
  return {
    status: entry.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    detail: `via hotstock (cache ${ageSec}s)`,
  };
}
