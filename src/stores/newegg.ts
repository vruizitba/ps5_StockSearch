import type { StockResult } from '../types';
import { BROWSER_HEADERS, fetchWithTimeout, error, looksBlocked } from './detect';
import { checkViaNowInStock } from './nowinstock';

/**
 * Newegg.
 *
 * La web (newegg.com/p/pl) devuelve 403 con CAPTCHA, pero su endpoint
 * ProductRealtime responde JSON a un fetch plano, sin key y sin muro:
 * es la fuente mas limpia de todas, porque da un booleano real.
 *
 * Con una salvedad medida en produccion: ese endpoint responde 200 desde una
 * conexion residencial y 403 desde las IPs de Cloudflare. Por eso se intenta
 * primero la via directa y, si aparece el bloqueo, se cae a nowinstock.
 * Asi el codigo sigue sirviendo si algun dia esto corre desde una IP casera.
 */
const NIS_ROW = 'Console: Pro 2TB : Newegg';
const ITEM = 'N82E16868110346'; // PlayStation 5 Pro Console
const API = 'https://www.newegg.com/product/api/ProductRealtime';

export const NEWEGG_URL = `https://www.newegg.com/p/${ITEM}?Item=${ITEM}`;

interface NeweggResponse {
  MainItem?: {
    Instock?: boolean;
    Stock?: number;
    Active?: string;
    FinalPrice?: number;
    Description?: { Title?: string };
  };
}

export async function checkNewegg(): Promise<StockResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API}?ItemNumber=${ITEM}`, {
      headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    });
  } catch {
    return checkViaNowInStock(NIS_ROW);
  }

  const body = await res.text();
  // Newegg bloquea las IPs de datacenter: no es una falla, es el caso esperado
  // en produccion. Se resuelve con el respaldo en vez de reportar BLOCKED.
  if (looksBlocked(res.status, body) || !res.ok) return checkViaNowInStock(NIS_ROW);

  let item: NeweggResponse['MainItem'];
  try {
    item = (JSON.parse(body) as NeweggResponse).MainItem;
  } catch {
    return error('respuesta no es JSON valido');
  }

  // La API devuelve 200 con "null" si el item no existe. Eso es un cambio de
  // catalogo, no una falta de stock: hay que avisar, no callar.
  if (!item) return error(`item ${ITEM} no existe en el catalogo`);
  if (typeof item.Instock !== 'boolean') return error('falta MainItem.Instock');

  const price = item.FinalPrice ? `$${item.FinalPrice.toFixed(2)}` : undefined;
  const detail = `Instock=${item.Instock} Stock=${item.Stock ?? '?'}`;

  return { status: item.Instock ? 'IN_STOCK' : 'OUT_OF_STOCK', price, detail };
}
