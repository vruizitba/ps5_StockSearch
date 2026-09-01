import type { StockResult } from '../types';
import { BROWSER_HEADERS, fetchWithTimeout, blocked, error, looksBlocked } from './detect';

/**
 * Newegg.
 *
 * La web (newegg.com/p/pl) devuelve 403 con CAPTCHA, pero su endpoint
 * ProductRealtime responde JSON a un fetch plano, sin key y sin muro.
 * Es la fuente mas limpia de todas las tiendas: da un booleano real.
 */
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
  } catch (e) {
    return error(`fetch fallo: ${String(e).slice(0, 120)}`);
  }

  const body = await res.text();
  if (looksBlocked(res.status, body)) return blocked(`HTTP ${res.status}`);
  if (!res.ok) return error(`HTTP ${res.status}`);

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
