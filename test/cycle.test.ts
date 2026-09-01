import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { checkStore } from '../src/cycle';
import { getState } from '../src/db';
import { fakeStore, mockResend, notificationRows, resetDb } from './helpers';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(resetDb);
afterEach(() => fetchMock.assertNoPendingInterceptors());

const IN_STOCK = { status: 'IN_STOCK', price: '$899.00', detail: 'test' } as const;

describe('alerta de stock', () => {
  it('manda el mail apenas una tienda pasa a disponible', async () => {
    mockResend(200);
    const store = fakeStore({ id: 'ps', result: IN_STOCK });
    const res = await checkStore(env, store, true);

    expect(res?.status).toBe('IN_STOCK');
    const state = await getState(env, 'ps');
    expect(state?.last_notified_at).toBeGreaterThan(0);
    expect(await notificationRows()).toEqual([
      { store_id: 'ps', kind: 'IN_STOCK', ok: 1, detail: null },
    ]);
  });

  it('si el mail no sale, NO marca notificado y reintenta al ciclo siguiente', async () => {
    // La regresion mas cara de todas. Antes se marcaba notificado pasara lo que
    // pasara: Resend rechazaba, el cooldown de 6 h se activaba igual y la alerta
    // no se reintentaba nunca. Stock disponible, cero correos.
    const store = fakeStore({ id: 'ps', result: IN_STOCK });

    mockResend(500, 3); // tres intentos, todos fallan
    await checkStore(env, store, true);

    let state = await getState(env, 'ps');
    expect(state?.last_notified_at).toBeNull();
    expect((await notificationRows())[0]).toMatchObject({ kind: 'IN_STOCK', ok: 0 });

    // Segundo ciclo: sigue habiendo stock y el mail vuelve a intentarse.
    mockResend(200, 1);
    await checkStore(env, store, true);

    state = await getState(env, 'ps');
    expect(state?.last_notified_at).toBeGreaterThan(0);
    expect((await notificationRows()).filter((n) => n.ok === 1).length).toBe(1);
  });

  it('no repite el mail mientras siga habiendo stock (cooldown)', async () => {
    mockResend(200, 1);
    const store = fakeStore({ id: 'ps', result: IN_STOCK });

    await checkStore(env, store, true);
    await checkStore(env, store, true);
    await checkStore(env, store, true);

    // Un solo interceptor consumido: los dos chequeos siguientes no mandaron nada.
    expect((await notificationRows()).length).toBe(1);
  });

  it('vuelve a avisar cuando el stock reaparece tras agotarse', async () => {
    const store = fakeStore({ id: 'ps', result: IN_STOCK });
    const agotado = fakeStore({ id: 'ps', result: { status: 'OUT_OF_STOCK' } });

    mockResend(200, 1);
    await checkStore(env, store, true);
    await checkStore(env, agotado, true);
    mockResend(200, 1);
    await checkStore(env, store, true);

    expect((await notificationRows()).length).toBe(2);
  });

  it('no manda mail si no hay stock', async () => {
    await checkStore(env, fakeStore({ id: 'ps', result: { status: 'OUT_OF_STOCK' } }), true);
    expect(await notificationRows()).toEqual([]);
  });

  it('una excepcion de la tienda queda como ERROR, nunca como sin stock', async () => {
    const store = fakeStore({
      id: 'ps',
      check: async () => {
        throw new Error('boom');
      },
    });
    const res = await checkStore(env, store, true);
    expect(res?.status).toBe('ERROR');
    expect(res?.detail).toContain('boom');
  });
});

describe('backoff ante fallas', () => {
  it('crece pero nunca pasa de 5 minutos', async () => {
    // El techo era de 30 min: una tienda con fallas se quedaba ciega justo
    // durante la ventana de un drop.
    const store = fakeStore({ id: 'ps', result: { status: 'BLOCKED', detail: '403' } });

    for (let i = 0; i < 8; i++) await checkStore(env, store, true);

    const state = await getState(env, 'ps');
    const espera = (state!.next_check_at - state!.checked_at) / 1000;
    expect(espera).toBeLessThanOrEqual(300);
    expect(espera).toBeGreaterThan(60);
    expect(state?.fail_streak).toBe(8);
  });

  it('un chequeo bueno resetea la racha y el intervalo', async () => {
    const roto = fakeStore({ id: 'ps', result: { status: 'ERROR', detail: 'x' } });
    const sano = fakeStore({ id: 'ps', result: { status: 'OUT_OF_STOCK' } });

    for (let i = 0; i < 4; i++) await checkStore(env, roto, true);
    await checkStore(env, sano, true);

    const state = await getState(env, 'ps');
    expect(state?.fail_streak).toBe(0);
    expect((state!.next_check_at - state!.checked_at) / 1000).toBe(60);
  });

  it('respeta next_check_at cuando no se fuerza', async () => {
    const store = fakeStore({ id: 'ps', result: { status: 'OUT_OF_STOCK' } });
    await checkStore(env, store, true);
    // Recien chequeado: el siguiente vence en 60 s, asi que este se saltea.
    expect(await checkStore(env, store, false)).toBeNull();
  });
});

describe('aviso de fuente rota', () => {
  it('avisa cuando una tienda lleva 30 min sin datos, y una sola vez', async () => {
    const store = fakeStore({ id: 'ps', result: { status: 'BLOCKED', detail: '403' } });

    // 29 fallas: todavia no llega a los 30 minutos.
    for (let i = 0; i < 29; i++) await checkStore(env, store, true);
    expect(await notificationRows()).toEqual([]);

    mockResend(200, 1);
    await checkStore(env, store, true); // la numero 30 dispara el aviso
    expect((await notificationRows()).length).toBe(1);
    expect((await notificationRows())[0]).toMatchObject({ kind: 'UNHEALTHY', ok: 1 });

    // Las siguientes no repiten: health_alerted_at ya quedo marcado.
    await checkStore(env, store, true);
    await checkStore(env, store, true);
    expect((await notificationRows()).length).toBe(1);
  });

  it('un aviso de salud que no sale se reintenta', async () => {
    const store = fakeStore({ id: 'ps', result: { status: 'ERROR', detail: 'x' } });
    for (let i = 0; i < 29; i++) await checkStore(env, store, true);

    mockResend(400, 1); // rechazado, sin reintentos por ser 4xx
    await checkStore(env, store, true);
    expect((await getState(env, 'ps'))?.health_alerted_at).toBeNull();

    mockResend(200, 1);
    await checkStore(env, store, true);
    expect((await getState(env, 'ps'))?.health_alerted_at).toBeGreaterThan(0);
  });

  it('cuando la tienda se recupera, se limpia la marca de aviso', async () => {
    const roto = fakeStore({ id: 'ps', result: { status: 'BLOCKED', detail: '403' } });
    for (let i = 0; i < 29; i++) await checkStore(env, roto, true);
    mockResend(200, 1);
    await checkStore(env, roto, true);
    expect((await getState(env, 'ps'))?.health_alerted_at).toBeGreaterThan(0);

    await checkStore(env, fakeStore({ id: 'ps', result: { status: 'OUT_OF_STOCK' } }), true);
    expect((await getState(env, 'ps'))?.health_alerted_at).toBeNull();
  });
});
