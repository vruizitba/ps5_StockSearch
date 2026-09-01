import type { Env } from './types';
import { STORES, STORE_BY_ID } from './stores/index';
import { allStates, history, blockRate } from './db';
import { sendTestEmail } from './notify';
import { renderDashboard } from './ui';
import { checkStore, runCycle } from './cycle';
export { Ticker } from './ticker';

/** El id es fijo: un unico reloj para toda la app. */
function ticker(env: Env): DurableObjectStub {
  return env.TICKER.get(env.TICKER.idFromName('singleton'));
}

// Se intenta una vez por isolate. Es el arranque del reloj y tambien su red de
// seguridad: si la cadena de alarmas alguna vez se corta, la primera visita al
// dashboard la vuelve a armar.
let armedThisIsolate = false;
async function ensureTicking(env: Env): Promise<void> {
  if (armedThisIsolate) return;
  armedThisIsolate = true;
  try {
    await ticker(env).fetch('https://ticker/arm');
  } catch (e) {
    armedThisIsolate = false;
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

    if (path === '/health') return new Response('ok');

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
