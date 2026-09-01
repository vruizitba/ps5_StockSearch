import type { Env, StockResult } from './types';
import { STORES, type StoreMeta } from './stores/index';
import {
  recordCheck, getState, markNotified, markHealthAlerted, clearHealthAlert, prune,
  recordNotification,
} from './db';
import { alertInStock, alertUnhealthy } from './notify';

/** Si sigue habiendo stock, no repetir el mail antes de esto. */
const NOTIFY_COOLDOWN_MS = 6 * 3600_000;
/** Minutos de fallas seguidas antes de avisar que una fuente esta rota. */
const UNHEALTHY_AFTER_MIN = 30;
/**
 * Margen para considerar una tienda vencida.
 *
 * La alarma dispara cada 60 s y next_check_at se fija en +60 s exactos, asi que
 * cualquier demora (el jitter, o unos milisegundos de deriva) hace que la tienda
 * todavia no este vencida cuando llega el tick y se saltee hasta el siguiente.
 * Eso duplicaba el intervalo real a ~120 s. La gracia absorbe esa deriva.
 */
const DUE_GRACE_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Manda la alerta de stock y devuelve si salio.
 *
 * El orden importa: `markNotified` solo corre si Resend acepto el mail. Antes se
 * marcaba siempre, asi que un rechazo de Resend activaba igual el cooldown de
 * 6 horas y la alerta no se reintentaba nunca. El correo no llegaba y la app
 * creia haber avisado — exactamente el modo de falla que no se puede permitir.
 */
async function notifyInStock(
  env: Env,
  store: StoreMeta,
  result: StockResult,
): Promise<boolean> {
  let ok = false;
  let detail: string | null = 'excepcion antes de enviar';

  try {
    const outcome = await alertInStock(env, store, result);
    ok = outcome.ok;
    detail = outcome.failed.length
      ? outcome.failed.map((f) => `${f.to}: ${f.detail}`).join('; ').slice(0, 400)
      : null;
  } catch (e) {
    detail = `excepcion: ${String(e).slice(0, 200)}`;
  }

  // Si marcar falla, el peor caso es un mail repetido. Aceptable: el error
  // caro es el contrario, dar por avisado algo que nunca se envio.
  if (ok) {
    try {
      await markNotified(env, store.id);
    } catch (e) {
      console.error('markNotified fallo', store.id, String(e).slice(0, 150));
    }
  }

  try {
    await recordNotification(env, store.id, 'IN_STOCK', ok, detail);
  } catch (e) {
    console.error('recordNotification fallo', String(e).slice(0, 150));
  }

  return ok;
}

export async function checkStore(env: Env, store: StoreMeta, force: boolean): Promise<StockResult | null> {
  const prev = await getState(env, store.id);
  const now = Date.now();

  // next_check_at combina el intervalo normal con el backoff ante fallas.
  if (!force && prev && prev.next_check_at - DUE_GRACE_MS > now) return null;

  // Jitter: no pegarle a las tiendas siempre en el segundo redondo del minuto.
  if (!force) await sleep(Math.floor(Math.random() * 8000));

  let result: StockResult;
  try {
    result = await store.check(env);
  } catch (e) {
    result = { status: 'ERROR', detail: `excepcion: ${String(e).slice(0, 150)}` };
  }

  const before = await recordCheck(
    env, store.id, result, store.intervalSec, store.backoffOnFailure ?? true,
  );

  if (result.status === 'IN_STOCK') {
    const wasInStock = before?.status === 'IN_STOCK';
    const lastNotified = before?.last_notified_at ?? 0;
    const cooledDown = now - lastNotified > NOTIFY_COOLDOWN_MS;

    // Avisar en la transicion a disponible, o si sigue disponible pasado el
    // cooldown. Un envio fallido no deja `last_notified_at`, asi que el proximo
    // ciclo vuelve a intentarlo en vez de callarse seis horas.
    if (!wasInStock || cooledDown) {
      await notifyInStock(env, store, result);
    }
  }

  const failing = result.status === 'BLOCKED' || result.status === 'ERROR';
  if (failing) {
    const streak = (before?.fail_streak ?? 0) + 1;
    const failingForMin = (streak * store.intervalSec) / 60;
    if (failingForMin >= UNHEALTHY_AFTER_MIN && !before?.health_alerted_at) {
      // El aviso de salud no puede tumbar el ciclo de las demas tiendas.
      try {
        const outcome = await alertUnhealthy(env, store, result, Math.round(failingForMin));
        if (outcome.ok) await markHealthAlerted(env, store.id);
        await recordNotification(
          env, store.id, 'UNHEALTHY', outcome.ok,
          outcome.failed.map((f) => `${f.to}: ${f.detail}`).join('; ').slice(0, 400) || null,
        );
      } catch (e) {
        console.error('alertUnhealthy fallo', store.id, String(e).slice(0, 150));
      }
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
