import type { Env } from './types';
import { runCycle } from './cycle';

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

export class Ticker implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  /** Arma la alarma si no hay ninguna pendiente. Idempotente. */
  async fetch(): Promise<Response> {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + 1000);
      return Response.json({ armed: true });
    }
    return Response.json({ armed: false, nextAlarm: current });
  }

  async alarm(): Promise<void> {
    // La proxima alarma se programa ANTES de trabajar. Si el ciclo explota, la
    // cadena sigue viva; al reves, un error dejaria el reloj muerto para siempre.
    await this.state.storage.setAlarm(Date.now() + TICK_MS);

    try {
      await runCycle(this.env);
    } catch (e) {
      console.error('ciclo fallo dentro de la alarma', String(e).slice(0, 200));
    }
  }
}
