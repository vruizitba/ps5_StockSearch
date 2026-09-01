import type { Env, StockResult } from './types';
import { STORES, STORE_BY_ID, type StoreMeta } from './stores/index';
import {
  recordCheck, getState, allStates, markNotified, markHealthAlerted,
  clearHealthAlert, history, blockRate, prune,
} from './db';
import { alertInStock, alertUnhealthy, sendTestEmail } from './notify';
import { renderDashboard } from './ui';

/** Si sigue habiendo stock, no repetir el mail antes de esto. */
const NOTIFY_COOLDOWN_MS = 6 * 3600_000;
/** Minutos de fallas seguidas antes de avisar que una fuente esta rota. */
const UNHEALTHY_AFTER_MIN = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkStore(env: Env, store: StoreMeta, force: boolean): Promise<StockResult | null> {
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

async function runCycle(env: Env): Promise<void> {
  // allSettled: una tienda caida no puede tumbar el ciclo de las demas.
  await Promise.allSettled(STORES.map((s) => checkStore(env, s, false)));

  // Poda ocasional del historial (~1 de cada 500 ciclos, o sea varias veces por dia).
  if (Math.random() < 0.002) await prune(env);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Se espera el ciclo en vez de delegarlo a waitUntil: si el handler retorna
    // antes de que termine, el runtime puede dar el evento por concluido y
    // cortar los chequeos a la mitad.
    await runCycle(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/status') {
      const states = await allStates(env);
      const byId = new Map(states.map((s) => [s.store_id, s]));
      return json({
        now: Date.now(),
        stores: STORES.map((s) => {
          const st = byId.get(s.id);
          return {
            id: s.id,
            name: s.name,
            url: s.url,
            direct: s.direct,
            source: s.source,
            status: st?.status ?? 'PENDING',
            price: st?.price ?? null,
            detail: st?.detail ?? null,
            checkedAt: st?.checked_at ?? null,
            failStreak: st?.fail_streak ?? 0,
          };
        }),
      });
    }

    if (path === '/api/history') {
      const hours = Math.min(Number(url.searchParams.get('hours') ?? 24) || 24, 720);
      return json(await history(env, hours));
    }

    if (path === '/api/blockrate') {
      const hours = Math.min(Number(url.searchParams.get('hours') ?? 168) || 168, 720);
      return json(await blockRate(env, hours));
    }

    if (path === '/health') return new Response('ok');

    // Rutas que disparan acciones: protegidas con ADMIN_TOKEN para que la pagina
    // publica no permita a cualquiera mandar mails o gastar el presupuesto.
    const token = url.searchParams.get('token');
    const authed = Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;

    if (path === '/api/test-email' && request.method === 'POST') {
      if (!authed) return json({ error: 'token invalido' }, 401);
      await sendTestEmail(env);
      return json({ sent: true, to: env.ALERT_EMAILS });
    }

    if (path.startsWith('/api/check/') && request.method === 'POST') {
      if (!authed) return json({ error: 'token invalido' }, 401);
      const store = STORE_BY_ID.get(path.slice('/api/check/'.length));
      if (!store) return json({ error: 'tienda desconocida' }, 404);
      const result = await checkStore(env, store, true);
      return json({ store: store.id, result });
    }

    // Acepta GET ademas de POST: sirve como disparador externo para cuando el
    // cron de Cloudflare no corre (bug conocido en cuentas nuevas). Un servicio
    // de cron gratuito puede pegarle cada minuto. Es idempotente: next_check_at
    // hace que una llamada de mas no repita chequeos ya hechos.
    if (path === '/api/run') {
      if (!authed) return json({ error: 'token invalido' }, 401);
      ctx.waitUntil(runCycle(env));
      return json({ started: true, at: Date.now() });
    }

    if (path === '/') {
      return new Response(renderDashboard(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
