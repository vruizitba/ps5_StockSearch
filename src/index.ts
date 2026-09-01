import type { Env, StockResult } from './types';
import { STORES, STORE_BY_ID } from './stores/index';
import { allStates, history, blockRate, lastNotifications, lastFailedNotification } from './db';
import { sendTestEmail, alertInStock } from './notify';
import { renderDashboard } from './ui';
import { checkStore, runCycle } from './cycle';
export { Ticker } from './ticker';

/**
 * Minutos sin ningun chequeo fresco a partir de los cuales /health responde 503.
 *
 * Es el gancho para un monitor de uptime externo (UptimeRobot, cron-job.org y
 * similares tienen plan gratuito). El modo de falla que ningun chequeo interno
 * puede cubrir es que la app entera deje de correr: si nadie la ejecuta, nadie
 * puede avisarlo desde adentro. Un pinger de afuera si.
 */
const STALE_AFTER_MS = 5 * 60_000;

/** El id es fijo: un unico reloj para toda la app. */
function ticker(env: Env): DurableObjectStub {
  return env.TICKER.get(env.TICKER.idFromName('singleton'));
}

// Se reintenta cada pocos minutos, no una sola vez por isolate. Es el arranque
// del reloj y tambien su red de seguridad: si la cadena de alarmas se corta o
// queda trabada, cualquier visita al dashboard la vuelve a armar.
const ARM_RECHECK_MS = 5 * 60_000;
let lastArmAttempt = 0;

async function ensureTicking(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastArmAttempt < ARM_RECHECK_MS) return;
  lastArmAttempt = now;
  try {
    await ticker(env).fetch('https://ticker/arm');
  } catch (e) {
    lastArmAttempt = 0;
    console.error('no se pudo armar el reloj', String(e).slice(0, 150));
  }
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

    ctx.waitUntil(ensureTicking(env));

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

    // Historial de correos: si una alerta se intento y Resend la rechazo, queda
    // aca. Es la unica forma de auditar el canal sin mirar los logs en vivo.
    if (path === '/api/notifications') {
      const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
      return json(await lastNotifications(env, limit));
    }

    /**
     * Liveness con contenido.
     *
     * Devuelve 503 si hace mas de STALE_AFTER_MS que no se chequea nada, o si
     * el ultimo correo fallo. Un monitor externo gratuito apuntado aca convierte
     * "la app se murio callada" en un mail — que es justamente el escenario del
     * que la app no puede avisar sola.
     */
    if (path === '/health') {
      const states = await allStates(env);
      const newest = states.reduce((m, s) => Math.max(m, s.checked_at), 0);
      const ageMs = newest ? Date.now() - newest : Infinity;
      const stale = ageMs > STALE_AFTER_MS;

      const failed = await lastFailedNotification(env);
      // Solo importa un fallo reciente: uno de hace dias ya no dice nada del ahora.
      const recentFailure = failed && Date.now() - failed.created_at < 3600_000 ? failed : null;

      const blind = states.filter(
        (s) => s.status === 'BLOCKED' || s.status === 'ERROR' || s.status === 'DISABLED',
      ).length;

      const ok = !stale && !recentFailure && blind < STORES.length;
      return json(
        {
          ok,
          stale,
          lastCheckAgeSec: newest ? Math.round(ageMs / 1000) : null,
          storesTracked: states.length,
          storesBlind: blind,
          lastEmailFailure: recentFailure
            ? { kind: recentFailure.kind, store: recentFailure.store_id, detail: recentFailure.detail }
            : null,
        },
        ok ? 200 : 503,
      );
    }

    if (path === '/api/ticker') {
      const res = await ticker(env).fetch('https://ticker/arm');
      return new Response(await res.text(), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // Rutas que disparan acciones: protegidas con ADMIN_TOKEN para que la pagina
    // publica no permita a cualquiera mandar mails o gastar el presupuesto.
    const token = url.searchParams.get('token');
    const authed = Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;

    if (path === '/api/test-email' && request.method === 'POST') {
      if (!authed) return json({ error: 'token invalido' }, 401);
      const outcome = await sendTestEmail(env);
      // El status refleja lo que paso de verdad. Antes siempre devolvia
      // {sent:true} aunque Resend hubiera rechazado el mail.
      return json(outcome, outcome.ok ? 200 : 502);
    }

    /**
     * Ensayo de alerta de stock: manda el mail real que llegaria en un drop.
     *
     * Recorre la misma funcion que usa el ciclo, con la misma plantilla, el
     * mismo remitente y los mismos destinatarios. Es la unica prueba que
     * responde la pregunta que importa —"cuando haya stock, ¿me llega?"— sin
     * esperar a que haya stock. No toca la base: no marca notificado ni cambia
     * el estado, asi que no puede silenciar una alerta de verdad.
     */
    if (path === '/api/simulate' && request.method === 'POST') {
      if (!authed) return json({ error: 'token invalido' }, 401);
      const storeId = url.searchParams.get('store') ?? 'playstation';
      const store = STORE_BY_ID.get(storeId);
      if (!store) return json({ error: `tienda desconocida: ${storeId}` }, 404);

      const fake: StockResult = {
        status: 'IN_STOCK',
        price: '$899.00',
        detail: 'SIMULACRO - no hay stock real',
      };
      const outcome = await alertInStock(env, store, fake);
      return json({ simulated: store.id, ...outcome }, outcome.ok ? 200 : 502);
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
