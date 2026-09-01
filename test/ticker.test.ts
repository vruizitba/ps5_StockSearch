import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { needsRearm } from '../src/ticker';
import { mockResend, notificationRows, resetDb } from './helpers';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  // Un ciclo disparado por la alarma no debe salir a la red de verdad.
  for (const host of [
    'https://api.direct.playstation.com',
    'https://www.hotstock.io',
    'https://www.nowinstock.net',
    'https://www.newegg.com',
  ]) {
    fetchMock.get(host).intercept({ path: () => true }).reply(403, '').persist();
  }
});
beforeEach(resetDb);

function stub() {
  return env.TICKER.get(env.TICKER.idFromName('test-clock'));
}

// Deja el reloj quieto: una alarma viva seguiria disparando ciclos durante los
// demas archivos de test.
afterAll(async () => {
  await runInDurableObject(stub(), async (_i, state) => state.storage.deleteAlarm());
});

describe('reloj', () => {
  it('se arma cuando no hay alarma pendiente', async () => {
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });

    const res = await stub().fetch('https://ticker/arm');
    expect(await res.json()).toMatchObject({ armed: true });

    const alarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(0);
  });

  it('es idempotente: no pisa una alarma sana', async () => {
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.setAlarm(Date.now() + 45_000);
    });

    const res = await stub().fetch('https://ticker/arm');
    expect(await res.json()).toMatchObject({ armed: false });
  });

  it('reprograma una alarma trabada en el pasado', () => {
    // Sin esto el monitor quedaba muerto en silencio: getAlarm() seguia
    // devolviendo una fecha, el armado idempotente no hacia nada, y nadie
    // volvia a chequear jamas.
    const now = Date.now();
    expect(needsRearm(null, now)).toBe(true);            // no hay alarma
    expect(needsRearm(now + 30_000, now)).toBe(false);   // futura, sana
    expect(needsRearm(now - 30_000, now)).toBe(false);   // vencida hace poco
    expect(needsRearm(now - 10 * 60_000, now)).toBe(true); // trabada
  });

  it('la proxima alarma se programa antes de trabajar', async () => {
    // Si el ciclo explotara y la alarma se programara despues, la cadena se
    // cortaria para siempre y el monitor moriria callado.
    await runInDurableObject(stub(), async (instance, state) => {
      await state.storage.deleteAll();
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      const next = await state.storage.getAlarm();
      expect(next!).toBeGreaterThan(Date.now());
    });
  }, 40_000);

  it('avisa por mail cuando el reloj estuvo parado', async () => {
    mockResend(200, 1);
    await runInDurableObject(stub(), async (instance, state) => {
      await state.storage.put('lastTick', Date.now() - 20 * 60_000);
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    const rows = await notificationRows();
    expect(rows.some((n) => n.kind === 'CLOCK_GAP' && n.ok === 1)).toBe(true);
  }, 40_000);

  it('no avisa cuando los ticks vienen seguidos', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      await state.storage.put('lastTick', Date.now() - 61_000);
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    expect((await notificationRows()).some((n) => n.kind === 'CLOCK_GAP')).toBe(false);
  }, 40_000);
});
