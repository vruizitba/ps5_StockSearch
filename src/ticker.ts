import type { Env } from './types';
import { runCycle } from './cycle';
import { alertClockGap } from './notify';
import { recordNotification } from './db';

/**
 * Reloj propio, hecho con la alarma de un Durable Object.
 *
 * Los Cron Triggers de Cloudflare quedaron registrados en esta cuenta pero
 * nunca dispararon: seis minutos de `wrangler tail` capturaron 196 invocaciones
 * fetch y cero programadas. Es un problema conocido en cuentas nuevas.
 *
 * Las alarmas de Durable Objects son un mecanismo distinto y si funcionan, asi
 * que el objeto se reprograma solo cada minuto. Todo queda adentro de Cloudflare,
 * sin depender de un servicio externo ni de exponer el ADMIN_TOKEN afuera.
 */
const TICK_MS = 60_000;

/**
 * Una alarma pendiente que ya vencio hace mas que esto se considera trabada y
 * se reprograma. Cubre el caso en que el runtime pierde la alarma: `getAlarm()`
 * sigue devolviendo una fecha, asi que el armado idempotente no hacia nada y el
 * monitor quedaba muerto sin que nadie lo notara.
 */
const STUCK_ALARM_MS = 3 * 60_000;

/** Hueco entre ticks a partir del cual se avisa por mail. */
const GAP_ALERT_MS = 5 * 60_000;

/**
 * ¿Hay que reprogramar la alarma?
 *
 * Se separa de la clase para poder probarla sola: forzar una alarma vencida
 * dentro del runtime no se puede, porque al ponerla en el pasado dispara al
 * instante y deja de estar pendiente.
 */
export function needsRearm(current: number | null, now: number): boolean {
  return current === null || current < now - STUCK_ALARM_MS;
}

export class Ticker implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  /**
   * Arma la alarma. Idempotente, salvo que la pendiente este trabada.
   *
   * Devuelve tambien el ultimo tick para que `/health` pueda mirar el reloj sin
   * depender de la tabla de chequeos.
   */
  async fetch(): Promise<Response> {
    const current = await this.state.storage.getAlarm();
    const lastTick = (await this.state.storage.get<number>('lastTick')) ?? null;
    const now = Date.now();

    if (needsRearm(current, now)) {
      await this.state.storage.setAlarm(now + 1000);
      return Response.json({
        armed: true,
        rearmed: current !== null,
        staleAlarm: current,
        lastTick,
      });
    }
    return Response.json({ armed: false, nextAlarm: current, lastTick });
  }

  async alarm(): Promise<void> {
    // La proxima alarma se programa ANTES de trabajar. Si el ciclo explota, la
    // cadena sigue viva; al reves, un error dejaria el reloj muerto para siempre.
    const now = Date.now();
    await this.state.storage.setAlarm(now + TICK_MS);

    const prevTick = (await this.state.storage.get<number>('lastTick')) ?? 0;
    await this.state.storage.put('lastTick', now);

    // Un hueco significa que el monitor estuvo ciego. No hay forma de recuperar
    // lo que paso ahi, pero si de enterarse: el silencio no puede pasar por
    // "no hubo stock".
    if (prevTick && now - prevTick > GAP_ALERT_MS) {
      const gapMin = Math.round((now - prevTick) / 60_000);
      try {
        const outcome = await alertClockGap(this.env, gapMin);
        await recordNotification(this.env, '-', 'CLOCK_GAP', outcome.ok, `hueco ${gapMin} min`);
      } catch (e) {
        console.error('aviso de hueco fallo', String(e).slice(0, 150));
      }
    }

    try {
      await runCycle(this.env);
    } catch (e) {
      console.error('ciclo fallo dentro de la alarma', String(e).slice(0, 200));
    }
  }
}
