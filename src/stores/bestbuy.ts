import type { Env, StockResult } from '../types';
import { fetchWithTimeout, blocked, error, looksBlocked } from './detect';

/**
 * Best Buy via su API oficial.
 *
 * La web de Best Buy corta la conexion a un fetch plano, pero la API publica
 * autentica por key y no por IP, asi que funciona desde cualquier lado.
 * Es el unico camino legitimo y ademas el mas confiable.
 *
 * La key gratuita se pide en https://developer.bestbuy.com y puede demorar dias.
 * Sin ella la tienda queda DISABLED y no rompe el resto del ciclo.
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
  if (!key) {
    return { status: 'DISABLED', detail: 'falta BESTBUY_API_KEY' };
  }

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
