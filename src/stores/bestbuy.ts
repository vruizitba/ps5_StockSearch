import type { Env, StockResult } from '../types';
import { fetchWithTimeout, blocked, error, looksBlocked } from './detect';
import { checkViaHotstock } from './hotstock';

/**
 * Best Buy via su API oficial.
 *
 * La web de Best Buy corta la conexion a un fetch plano, pero la API publica
 * autentica por key y no por IP, asi que funciona desde cualquier lado.
 * Es el unico camino legitimo y ademas el mas confiable.
 *
 * La key gratuita se pide en https://developer.bestbuy.com y puede demorar dias.
 * Mientras no este, el estado sale de hotstock, que tambien trackea Best Buy:
 * asi la tienda funciona desde el primer dia. La diferencia es el precio, que
 * hotstock no publica y la API si.
 */
const SKU = '6601524'; // PlayStation 5 Pro Console (SKU confirmado en la URL del producto)
const API = `https://api.bestbuy.com/v1/products(sku=${SKU})`;

export const BESTBUY_URL = `https://www.bestbuy.com/site/playstation-5-pro-console/${SKU}.p?skuId=${SKU}`;

interface BestBuyResponse {
  products?: Array<{
    sku?: number;
    name?: string;
    salePrice?: number;
    onlineAvailability?: boolean;
    orderable?: string;
  }>;
}

export async function checkBestBuy(env: Env): Promise<StockResult> {
  const key = env.BESTBUY_API_KEY;
  if (!key) return checkViaHotstock('Best Buy');

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${API}?apiKey=${encodeURIComponent(key)}&format=json&show=sku,name,salePrice,onlineAvailability,orderable`,
      { headers: { Accept: 'application/json' } },
    );
  } catch (e) {
    return error(`fetch fallo: ${String(e).slice(0, 120)}`);
  }

  const body = await res.text();
  if (res.status === 403) return error('API key rechazada por Best Buy');
  if (!res.ok && res.status >= 500) return checkViaHotstock('Best Buy');
  if (looksBlocked(res.status, body)) return blocked(`HTTP ${res.status}`);
  if (!res.ok) return error(`HTTP ${res.status}`);

  let product: NonNullable<BestBuyResponse['products']>[number] | undefined;
  try {
    product = (JSON.parse(body) as BestBuyResponse).products?.[0];
  } catch {
    return error('respuesta no es JSON valido');
  }

  if (!product) return error(`la API no devolvio el SKU ${SKU}`);
  if (typeof product.onlineAvailability !== 'boolean') {
    return error('falta onlineAvailability');
  }

  const price = product.salePrice ? `$${product.salePrice.toFixed(2)}` : undefined;
  return {
    status: product.onlineAvailability ? 'IN_STOCK' : 'OUT_OF_STOCK',
    price,
    detail: `onlineAvailability=${product.onlineAvailability}`,
  };
}
