import type { StockResult } from '../types';
import { BROWSER_HEADERS, fetchWithTimeout, blocked, error, looksBlocked } from './detect';

/**
 * PlayStation Direct.
 *
 * La pagina de producto (direct.playstation.com) esta detras de Akamai Bot
 * Manager y NO trae el stock: sirve todos los estados ocultos con class="hide"
 * y deja que su JavaScript decida cual mostrar. Su endpoint interno devuelve 403
 * incluso llamado desde el navegador con sesion valida.
 *
 * Pero el host de API es otro y no esta protegido: api.direct.playstation.com
 * responde el JSON de SAP Commerce a un fetch plano. El campo stock.stockLevelStatus
 * es exactamente el que consume el JS del propio sitio.
 *
 * Verificado: la consola da outOfStock mientras los accesorios dan inStock, o sea
 * que el campo discrimina de verdad y no es un default del template.
 *
 * Sony responde 403 de forma intermitente a las IPs de Cloudflare: algunas de sus
 * IPs de salida estan marcadas y otras no, asi que el mismo pedido pasa o falla
 * segun cual le toque. No es limite de frecuencia; diez consultas seguidas desde
 * una conexion residencial dan 200. Por eso se reintenta: cada intento sale por
 * otra IP y suele pasar en el segundo o tercero.
 */
const MAX_ATTEMPTS = 7;
const PRODUCT_CODE = '1000050928'; // PlayStation 5 Pro Console - 2 TB
const API =
  'https://api.direct.playstation.com/commercewebservices/ps-direct-us/users/anonymous/products/productList';

export const PS_DIRECT_URL =
  'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb';

interface OccProduct {
  code?: string;
  name?: string;
  price?: { formattedValue?: string };
  stock?: { stockLevelStatus?: string };
}

export async function checkPlayStation(): Promise<StockResult> {
  let body = '';
  let lastStatus = 0;
  let ok = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${API}?productCodes=${PRODUCT_CODE}`, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
      });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) return error(`fetch fallo: ${String(e).slice(0, 120)}`);
      continue;
    }

    lastStatus = res.status;
    body = await res.text();

    if (!looksBlocked(res.status, body) && res.ok) {
      ok = true;
      break;
    }
    // Pausa breve entre intentos: la espera no consume CPU del Worker.
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  if (!ok) {
    return looksBlocked(lastStatus, body)
      ? blocked(`HTTP ${lastStatus} en ${MAX_ATTEMPTS} intentos`)
      : error(`HTTP ${lastStatus}`);
  }

  let product: OccProduct | undefined;
  try {
    const data = JSON.parse(body) as { products?: OccProduct[] };
    product = data.products?.find((p) => p.code === PRODUCT_CODE);
  } catch {
    return error('respuesta no es JSON valido');
  }

  if (!product) return error(`la API no devolvio el producto ${PRODUCT_CODE}`);

  const level = product.stock?.stockLevelStatus;
  if (!level) return error('falta stock.stockLevelStatus en la respuesta');

  const price = product.price?.formattedValue;

  // Solo inStock y lowStock son comprables. comingSoon y outOfStock no lo son.
  // Un valor desconocido se reporta como ERROR en vez de adivinar: si Sony
  // agrega un estado nuevo, preferimos un aviso a una alerta falsa.
  if (level === 'inStock' || level === 'lowStock') {
    return { status: 'IN_STOCK', price, detail: `stockLevelStatus=${level}` };
  }
  if (level === 'outOfStock' || level === 'comingSoon') {
    return { status: 'OUT_OF_STOCK', price, detail: `stockLevelStatus=${level}` };
  }
  return error(`stockLevelStatus desconocido: ${level}`);
}
