import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { checkPlayStation } from '../src/stores/playstation';
import { checkBestBuy } from '../src/stores/bestbuy';
import { looksBlocked } from '../src/stores/detect';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const PS_HOST = 'https://api.direct.playstation.com';
const PS_PATH = '/commercewebservices/ps-direct-us/users/anonymous/products/productList';

function psReply(status: number, body: unknown, times = 1): void {
  fetchMock
    .get(PS_HOST)
    .intercept({ path: (p) => p.startsWith(PS_PATH), method: 'GET' })
    .reply(status, body)
    .times(times);
}

function psProduct(stockLevelStatus: string) {
  return {
    products: [
      {
        code: '1000050928',
        name: 'PlayStation 5 Pro',
        price: { formattedValue: '$899.00' },
        stock: { stockLevelStatus },
      },
    ],
  };
}

describe('deteccion de bloqueo', () => {
  it('trata 403, 429 y 503 como bloqueo', () => {
    expect(looksBlocked(403, '')).toBe(true);
    expect(looksBlocked(429, '')).toBe(true);
    expect(looksBlocked(503, '')).toBe(true);
  });

  it('reconoce muros anti-bot en el cuerpo aunque el status sea 200', () => {
    expect(looksBlocked(200, '<html>Please complete the CAPTCHA</html>')).toBe(true);
    expect(looksBlocked(200, '<html>Access Denied</html>')).toBe(true);
  });

  it('no confunde una pagina normal con un bloqueo', () => {
    expect(looksBlocked(200, '<html>PlayStation 5 Pro - Out of Stock</html>')).toBe(false);
  });
});

describe('PlayStation Direct', () => {
  it('inStock y lowStock son comprables', async () => {
    psReply(200, psProduct('inStock'));
    expect(await checkPlayStation()).toMatchObject({ status: 'IN_STOCK', price: '$899.00' });

    psReply(200, psProduct('lowStock'));
    expect(await checkPlayStation()).toMatchObject({ status: 'IN_STOCK' });
  });

  it('outOfStock y comingSoon no lo son', async () => {
    psReply(200, psProduct('outOfStock'));
    expect((await checkPlayStation()).status).toBe('OUT_OF_STOCK');

    psReply(200, psProduct('comingSoon'));
    expect((await checkPlayStation()).status).toBe('OUT_OF_STOCK');
  });

  it('registra en que intento paso, para poder medir si los reintentos sirven', async () => {
    psReply(403, 'forbidden', 2);
    psReply(200, psProduct('outOfStock'), 1);
    const res = await checkPlayStation();
    expect(res.detail).toContain('intento=3/7');
  });

  it('un estado nuevo de Sony da ERROR, no una alerta inventada', async () => {
    psReply(200, psProduct('preorderable'));
    const res = await checkPlayStation();
    expect(res.status).toBe('ERROR');
    expect(res.detail).toContain('preorderable');
  });

  it('reintenta los 403 intermitentes y aprovecha el que pasa', async () => {
    // Sony devuelve 403 segun por que IP de salida toque. El segundo intento
    // sale por otra y suele pasar.
    psReply(403, 'forbidden', 2);
    psReply(200, psProduct('inStock'), 1);
    expect((await checkPlayStation()).status).toBe('IN_STOCK');
  });

  it('403 en todos los intentos es BLOCKED, jamas OUT_OF_STOCK', async () => {
    psReply(403, 'forbidden', 7);
    const res = await checkPlayStation();
    expect(res.status).toBe('BLOCKED');
    expect(res.detail).toContain('7 intentos');
  }, 15_000);

  it('con la tienda ya bloqueada insiste mucho menos', async () => {
    // Sacarle el freno a esta tienda hizo trepar el bloqueo de Sony del 3% al
    // 80% en hora y media. Con la racha alta solo se sondea si se recupero.
    psReply(403, 'forbidden', 2);
    const res = await checkPlayStation(5);
    expect(res.status).toBe('BLOCKED');
    expect(res.detail).toContain('2 intentos');
  });

  it('con la tienda sana vuelve al esfuerzo completo', async () => {
    psReply(403, 'forbidden', 1);
    psReply(200, psProduct('inStock'), 1);
    expect((await checkPlayStation(0)).status).toBe('IN_STOCK');
  });

  it('JSON invalido es ERROR', async () => {
    psReply(200, 'no soy json');
    expect((await checkPlayStation()).status).toBe('ERROR');
  });

  it('si falta el producto en la respuesta es ERROR: cambio de catalogo', async () => {
    psReply(200, { products: [] });
    const res = await checkPlayStation();
    expect(res.status).toBe('ERROR');
    expect(res.detail).toContain('1000050928');
  });

  it('si falta stockLevelStatus es ERROR, no "sin stock"', async () => {
    psReply(200, { products: [{ code: '1000050928', price: { formattedValue: '$899.00' } }] });
    expect((await checkPlayStation()).status).toBe('ERROR');
  });
});

describe('Best Buy', () => {
  function bbReply(status: number, body: unknown): void {
    fetchMock
      .get('https://api.bestbuy.com')
      .intercept({ path: (p) => p.startsWith('/v1/products'), method: 'GET' })
      .reply(status, body);
  }

  const conKey = { ...env, BESTBUY_API_KEY: 'k' };

  it('onlineAvailability true es stock, con precio', async () => {
    bbReply(200, { products: [{ sku: 6601524, salePrice: 749.99, onlineAvailability: true }] });
    expect(await checkBestBuy(conKey)).toMatchObject({
      status: 'IN_STOCK',
      price: '$749.99',
    });
  });

  it('onlineAvailability false es agotado', async () => {
    bbReply(200, { products: [{ sku: 6601524, salePrice: 749.99, onlineAvailability: false }] });
    expect((await checkBestBuy(conKey)).status).toBe('OUT_OF_STOCK');
  });

  it('una key rechazada es ERROR y se ve en el detalle', async () => {
    bbReply(403, { error: 'nope' });
    const res = await checkBestBuy(conKey);
    expect(res.status).toBe('ERROR');
    expect(res.detail).toContain('key');
  });

  it('si falta onlineAvailability es ERROR, no "sin stock"', async () => {
    bbReply(200, { products: [{ sku: 6601524, salePrice: 749.99 }] });
    expect((await checkBestBuy(conKey)).status).toBe('ERROR');
  });
});
