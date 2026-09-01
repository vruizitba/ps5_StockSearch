import { fetchMock } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import hotstockHtml from './fixtures/hotstock';
import nowinstockHtml from './fixtures/nowinstock';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
// Los modulos cachean el snapshot a nivel modulo. Sin resetear, el primer test
// del archivo decidiria el resultado de todos los demas.
beforeEach(() => vi.resetModules());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function serve(origin: string, path: string, status: number, body: string): void {
  fetchMock
    .get(origin)
    .intercept({ path: (p) => p.startsWith(path), method: 'GET' })
    .reply(status, body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const HOTSTOCK = 'https://www.hotstock.io';
const HOTSTOCK_PATH = '/us/p/playstation-5-pro-console-2tb';
const NIS = 'https://www.nowinstock.net';
const NIS_PATH = '/videogaming/consoles/sonyps5/';

async function hotstock() {
  return (await import('../src/stores/hotstock')).checkViaHotstock;
}
async function nowinstock() {
  return (await import('../src/stores/nowinstock')).checkViaNowInStock;
}

describe('hotstock, sobre el HTML real del sitio', () => {
  it('lee el estado de cada tienda que monitoreamos', async () => {
    serve(HOTSTOCK, HOTSTOCK_PATH, 200, hotstockHtml);
    const check = await hotstock();
    // Un solo fetch alcanza para las cuatro: el snapshot queda cacheado.
    for (const shop of ['Amazon', 'Walmart', 'Target (Delivery)', 'GameStop']) {
      const res = await check(shop);
      expect(res.status, shop).toBe('OUT_OF_STOCK');
    }
  });

  it('detecta la fila que SI tiene stock', async () => {
    // La captura trae eBay en IN STOCK. Sirve de prueba de que el parser
    // distingue de verdad y no devuelve "agotado" para todo.
    serve(HOTSTOCK, HOTSTOCK_PATH, 200, hotstockHtml);
    expect((await (await hotstock())('eBay')).status).toBe('IN_STOCK');
  });

  it('una tienda que el sitio dejo de listar es ERROR, no "sin stock"', async () => {
    serve(HOTSTOCK, HOTSTOCK_PATH, 200, hotstockHtml);
    const res = await (await hotstock())('Tienda Inexistente');
    expect(res.status).toBe('ERROR');
    expect(res.detail).toContain('ya no lista');
  });

  it('si el sitio cambia de estructura da ERROR, nunca "sin stock"', async () => {
    serve(HOTSTOCK, HOTSTOCK_PATH, 200, '<html><body><p>rediseñado</p></body></html>');
    const res = await (await hotstock())('Amazon');
    expect(res.status).toBe('ERROR');
    expect(res.detail).toContain('ninguna fila');
  });

  it('un 403 es ERROR, nunca "sin stock"', async () => {
    serve(HOTSTOCK, HOTSTOCK_PATH, 403, 'forbidden');
    expect((await (await hotstock())('Amazon')).status).toBe('ERROR');
  });

  it('cachea el resultado bueno: un fetch por ciclo, no uno por tienda', async () => {
    // Un solo interceptor para cuatro consultas. Si pidiera de mas, el test
    // fallaria por conexion no interceptada.
    serve(HOTSTOCK, HOTSTOCK_PATH, 200, hotstockHtml);
    const check = await hotstock();
    await check('Amazon');
    await check('Walmart');
    await check('Target (Delivery)');
    await check('GameStop');
  });
});

describe('nowinstock, sobre el HTML real del sitio', () => {
  const FILA_NEWEGG = 'Console: Pro 2TB : Newegg';

  it('lee la fila de la PS5 Pro en Newegg con su precio', async () => {
    serve(NIS, NIS_PATH, 200, nowinstockHtml);
    const res = await (await nowinstock())(FILA_NEWEGG);
    expect(res.status).toBe('OUT_OF_STOCK');
    expect(res.price).toBe('$899.99');
  });

  it('detecta una fila con stock', async () => {
    // La captura trae "Console: Disc Slim w/NBA 2K26 : Amazon" en stockStatusIn.
    serve(NIS, NIS_PATH, 200, nowinstockHtml);
    const res = await (await nowinstock())('Console: Disc Slim w/NBA 2K26 : Amazon');
    expect(res.status).toBe('IN_STOCK');
  });

  it('no cruza el precio de una fila con la de al lado', async () => {
    serve(NIS, NIS_PATH, 200, nowinstockHtml);
    const check = await nowinstock();
    expect((await check('Console: Digital Slim : Newegg')).price).toBe('$599.00');
    expect((await check('Console: Disc Slim : Newegg')).price).toBe('$649.99');
  });

  it('una fila que desaparecio es ERROR, no "sin stock"', async () => {
    serve(NIS, NIS_PATH, 200, nowinstockHtml);
    const res = await (await nowinstock())('Console: Pro 4TB : Newegg');
    expect(res.status).toBe('ERROR');
  });

  it('si el sitio cambia de estructura da ERROR', async () => {
    serve(NIS, NIS_PATH, 200, '<html><body>nada</body></html>');
    expect((await (await nowinstock())(FILA_NEWEGG)).status).toBe('ERROR');
  });

  it('un 503 es ERROR, nunca "sin stock"', async () => {
    serve(NIS, NIS_PATH, 503, 'unavailable');
    expect((await (await nowinstock())(FILA_NEWEGG)).status).toBe('ERROR');
  });
});
