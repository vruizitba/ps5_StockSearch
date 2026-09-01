import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockResend, notificationRows, resetDb } from './helpers';

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();

  // La primera peticion arma el reloj, y su alarma corre un ciclo real que
  // escribiria en la base en medio de un test. Se provoca aca, con las tiendas
  // interceptadas, y se espera a que termine: despues el throttle de 5 minutos
  // impide que se repita durante el resto del archivo.
  fetchMock.get('https://api.direct.playstation.com').intercept({ path: () => true }).reply(403, '').persist();
  fetchMock.get('https://www.hotstock.io').intercept({ path: () => true }).reply(403, '').persist();
  fetchMock.get('https://www.nowinstock.net').intercept({ path: () => true }).reply(403, '').persist();
  fetchMock.get('https://www.newegg.com').intercept({ path: () => true }).reply(403, '').persist();

  await SELF.fetch('https://t.test/health');
  await new Promise((r) => setTimeout(r, 12_000));
}, 30_000);

beforeEach(resetDb);

const TOKEN = 'test-token';

/** Simula que una tienda fue chequeada hace `ageSec` segundos. */
async function seedState(storeId: string, status: string, ageSec: number): Promise<void> {
  const at = Date.now() - ageSec * 1000;
  await env.DB.prepare(
    `INSERT INTO store_state (store_id, status, price, detail, checked_at, fail_streak, next_check_at)
     VALUES (?, ?, NULL, NULL, ?, 0, ?)
     ON CONFLICT(store_id) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at`,
  )
    .bind(storeId, status, at, at + 60_000)
    .run();
}

describe('rutas que disparan acciones', () => {
  for (const [method, path] of [
    ['POST', '/api/test-email'],
    ['POST', '/api/simulate'],
    ['POST', '/api/check/playstation'],
    ['GET', '/api/run'],
  ] as const) {
    it(`${method} ${path} exige el token`, async () => {
      const res = await SELF.fetch(`https://t.test${path}`, { method });
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} rechaza un token equivocado`, async () => {
      const res = await SELF.fetch(`https://t.test${path}?token=otro`, { method });
      expect(res.status).toBe(401);
    });
  }
});

describe('ensayo de alerta', () => {
  it('manda el mail real de stock y devuelve 200', async () => {
    mockResend(200);
    const res = await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}&store=bestbuy`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ simulated: 'bestbuy', ok: true });
  });

  it('devuelve 502 si el mail no sale: no miente diciendo que lo mando', async () => {
    mockResend(422, 1);
    const res = await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it('deja el intento registrado, salga o no', async () => {
    mockResend(200, 1);
    await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}&store=bestbuy`, { method: 'POST' });
    mockResend(422, 1);
    await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}&store=newegg`, { method: 'POST' });

    const rows = await notificationRows();
    expect(rows.map((r) => [r.store_id, r.kind, r.ok])).toEqual([
      ['bestbuy', 'SIMULATE', 1],
      ['newegg', 'SIMULATE', 0],
    ]);
  });

  it('un ensayo fallido pone /health en rojo', async () => {
    // Si el ensayo no llega, el canal esta roto de verdad: no puede quedar
    // como si nada hubiera pasado.
    await seedState('playstation', 'OUT_OF_STOCK', 30);
    expect((await SELF.fetch('https://t.test/health')).status).toBe(200);

    mockResend(422, 1);
    await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}`, { method: 'POST' });
    expect((await SELF.fetch('https://t.test/health')).status).toBe(503);
  });

  it('404 para una tienda que no existe', async () => {
    const res = await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}&store=nope`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('no toca el estado: un ensayo no puede silenciar una alerta de verdad', async () => {
    mockResend(200);
    await SELF.fetch(`https://t.test/api/simulate?token=${TOKEN}&store=bestbuy`, { method: 'POST' });
    const row = await env.DB.prepare('SELECT * FROM store_state WHERE store_id = ?')
      .bind('bestbuy')
      .first();
    expect(row).toBeNull();
  });
});

describe('/health', () => {
  it('200 cuando los chequeos estan frescos', async () => {
    await seedState('playstation', 'OUT_OF_STOCK', 30);
    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stale: false });
  });

  it('503 cuando hace mas de 5 minutos que no se chequea nada', async () => {
    // Es el gancho para el monitor externo: el unico modo de falla que la app
    // no puede avisar sola es haber dejado de correr.
    await seedState('playstation', 'OUT_OF_STOCK', 600);
    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, stale: true });
  });

  it('503 cuando no hay ningun chequeo todavia', async () => {
    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(503);
  });

  it('503 cuando el ultimo correo fallo hace poco', async () => {
    await seedState('playstation', 'OUT_OF_STOCK', 30);
    await env.DB.prepare(
      'INSERT INTO notifications (store_id, kind, ok, detail, created_at) VALUES (?,?,?,?,?)',
    )
      .bind('playstation', 'IN_STOCK', 0, 'HTTP 422', Date.now() - 60_000)
      .run();

    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ lastEmailFailure: { kind: 'IN_STOCK' } });
  });

  it('un fallo de correo viejo ya no ensucia el estado', async () => {
    await seedState('playstation', 'OUT_OF_STOCK', 30);
    await env.DB.prepare(
      'INSERT INTO notifications (store_id, kind, ok, detail, created_at) VALUES (?,?,?,?,?)',
    )
      .bind('playstation', 'IN_STOCK', 0, 'HTTP 422', Date.now() - 5 * 3600_000)
      .run();

    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(200);
  });

  it('503 si todas las tiendas estan ciegas', async () => {
    for (const id of ['playstation', 'bestbuy', 'newegg', 'amazon', 'walmart', 'target', 'gamestop']) {
      await seedState(id, 'BLOCKED', 30);
    }
    const res = await SELF.fetch('https://t.test/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ storesBlind: 7 });
  });
});

describe('lecturas publicas', () => {
  it('/api/status lista las 7 tiendas aunque la base este vacia', async () => {
    const res = await SELF.fetch('https://t.test/api/status');
    const body = (await res.json()) as { stores: Array<{ status: string }> };
    expect(body.stores.length).toBe(7);
    expect(body.stores.every((s) => s.status === 'PENDING')).toBe(true);
  });

  it('/api/notifications devuelve el historial de correos', async () => {
    mockResend(200);
    await SELF.fetch(`https://t.test/api/test-email?token=${TOKEN}`, { method: 'POST' });
    const res = await SELF.fetch('https://t.test/api/notifications');
    expect(res.status).toBe(200);
  });

  it('/ sirve el dashboard', async () => {
    const res = await SELF.fetch('https://t.test/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('/ps5pro.jpg sirve la foto del dashboard', async () => {
    const res = await SELF.fetch('https://t.test/ps5pro.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    // Los dos primeros bytes de todo JPEG. Prueba que el base64 se decodifico
    // bien y no que se sirvio la cadena en texto.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it('una ruta desconocida da 404', async () => {
    expect((await SELF.fetch('https://t.test/nada')).status).toBe(404);
  });
});
