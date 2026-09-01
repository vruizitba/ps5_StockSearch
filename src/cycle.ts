import type { Env, StockResult } from './types';
import { STORES, type StoreMeta } from './stores/index';
import {
  recordCheck, getState, markNotified, markHealthAlerted, clearHealthAlert, prune,
} from './db';
import { alertInStock, alertUnhealthy } from './notify';

/** Si sigue habiendo stock, no repetir el mail antes de esto. */
const NOTIFY_COOLDOWN_MS = 6 * 3600_000;
/** Minutos de fallas seguidas antes de avisar que una fuente esta rota. */
const UNHEALTHY_AFTER_MIN = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkStore(env: Env, store: StoreMeta, force: boolean): Promise<StockResult | null> {
  const prev = await getState(env, store.id);
  const now = Date.now();

  // next_check_at combina el intervalo normal con el backoff ante fallas.
  if (!force && prev && prev.next_check_at > now) return null;

  // Jitter: no pegarle a las tiendas siempre en el segundo redondo del minuto.
  if (!force) await sleep(Math.floor(Math.random() * 8000));

  let result: StockResult;
  try {
    result = await store.check(env);
  } catch (e) {
    result = { status: 'ERROR', detail: `excepcion: ${String(e).slice(0, 150)}` };
  }

  const before = await recordCheck(env, store.id, result, store.intervalSec);

  if (result.status === 'IN_STOCK') {
    const wasInStock = before?.status === 'IN_STOCK';
    const lastNotified = before?.last_notified_at ?? 0;
    const cooledDown = now - lastNotified > NOTIFY_COOLDOWN_MS;

    // Avisar en la transicion a disponible, o si sigue disponible pasado el cooldown.
    if (!wasInStock || cooledDown) {
      await alertInStock(env, store, result);
      await markNotified(env, store.id);
    }
  }

  const failing = result.status === 'BLOCKED' || result.status === 'ERROR';
  if (failing) {
    const streak = (before?.fail_streak ?? 0) + 1;
    const failingForMin = (streak * store.intervalSec) / 60;
    if (failingForMin >= UNHEALTHY_AFTER_MIN && !before?.health_alerted_at) {
      await alertUnhealthy(env, store, result, Math.round(failingForMin));
      await markHealthAlerted(env, store.id);
    }
  } else if (before?.health_alerted_at) {
    await clearHealthAlert(env, store.id);
  }

  return result;
}

export async function runCycle(env: Env): Promise<void> {
  // allSettled: una tienda caida no puede tumbar el ciclo de las demas.
  await Promise.allSettled(STORES.map((s) => checkStore(env, s, false)));

  // Poda ocasional del historial (~1 de cada 500 ciclos, o sea varias veces por dia).
  if (Math.random() < 0.002) await prune(env);
}

