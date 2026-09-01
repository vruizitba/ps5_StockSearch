/**
 * Cuatro estados, no dos.
 *
 * La distincion entre BLOCKED y OUT_OF_STOCK es el corazon de la app: si un
 * bloqueo se contara como "no hay stock", un scraper roto se veria identico a
 * una consola agotada y el usuario nunca se enteraria de que quedo ciego.
 */
export type Status =
  | 'IN_STOCK'
  | 'OUT_OF_STOCK'
  | 'BLOCKED'    // captcha, 403, muro anti-bot
  | 'ERROR'      // timeout, JSON invalido, HTML que ya no matchea
  | 'DISABLED';  // falta una API key: la tienda no se chequea

export interface StockResult {
  status: Status;
  /** Precio formateado tal como lo publica la tienda, ej "$899.00". */
  price?: string;
  /** Senal cruda observada. Va al dashboard para depurar sin releer el sitio. */
  detail?: string;
}

export interface Store {
  id: string;
  name: string;
  /** Link directo al producto. Va en el mail de alerta. */
  url: string;
  /** Segundos entre chequeos. */
  intervalSec: number;
  check(env: Env): Promise<StockResult>;
}

export interface Env {
  DB: D1Database;
  TICKER: DurableObjectNamespace;
  RESEND_API_KEY: string;
  BESTBUY_API_KEY?: string;
  ADMIN_TOKEN?: string;
  ALERT_EMAILS: string;
  FROM_EMAIL: string;
}

export interface StoreState {
  store_id: string;
  status: Status;
  price: string | null;
  detail: string | null;
  checked_at: number;
  last_notified_at: number | null;
  fail_streak: number;
  next_check_at: number;
  health_alerted_at: number | null;
}
