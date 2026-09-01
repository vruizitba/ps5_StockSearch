import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { send, alertInStock } from '../src/notify';
import type { AlertMessage } from '../src/channels/types';
import { fakeStore, mockResend } from './helpers';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const MSG: AlertMessage = { subject: 'asunto', html: '<p>h</p>', text: 'texto' };

/** Env con los dos canales configurados. */
const DOS = { ...env, TELEGRAM_BOT_TOKEN: 'bot123', TELEGRAM_CHAT_ID: '999' };

function mockTelegram(status: number, times = 1, body: unknown = { ok: true }): void {
  fetchMock
    .get('https://api.telegram.org')
    .intercept({ path: (p) => p.includes('/sendMessage'), method: 'POST' })
    .reply(status, body)
    .times(times);
}

describe('varios canales', () => {
  it('manda por los dos cuando los dos estan configurados', async () => {
    mockResend(200);
    mockTelegram(200);
    const out = await send(DOS, MSG);
    expect(out.ok).toBe(true);
    expect(out.channels.sort()).toEqual(['email', 'telegram']);
    expect(out.delivered.length).toBe(2);
  });

  it('si el correo se cae, Telegram entrega igual', async () => {
    // Este es el punto de todo el canal doble: un proveedor con un mal dia ya
    // no puede dejarte sin la alerta.
    mockResend(500, 3);
    mockTelegram(200);
    const out = await send(DOS, MSG);
    expect(out.ok).toBe(true);
    expect(out.delivered).toEqual(['telegram:999']);
    expect(out.failed.length).toBe(1);
  });

  it('si Telegram se cae, el correo entrega igual', async () => {
    mockResend(200);
    mockTelegram(500, 3);
    const out = await send(DOS, MSG);
    expect(out.ok).toBe(true);
    expect(out.delivered).toEqual(['uno@ejemplo.test']);
  });

  it('solo si fallan LOS DOS la alerta se da por no entregada', async () => {
    mockResend(500, 3);
    mockTelegram(500, 3);
    const out = await send(DOS, MSG);
    expect(out.ok).toBe(false);
    expect(out.failed.length).toBe(2);
  });

  it('un canal sin configurar se saltea, no falla', async () => {
    mockResend(200);
    const out = await send({ ...env, TELEGRAM_BOT_TOKEN: '' }, MSG);
    expect(out.ok).toBe(true);
    expect(out.channels).toEqual(['email']);
  });

  it('Telegram sin chat id no cuenta como configurado', async () => {
    mockResend(200);
    const out = await send({ ...DOS, TELEGRAM_CHAT_ID: '' }, MSG);
    expect(out.channels).toEqual(['email']);
  });

  it('no reintenta un 4xx de Telegram: repetirlo da el mismo error', async () => {
    mockResend(200);
    mockTelegram(400, 1, { ok: false, description: 'chat not found' });
    const out = await send(DOS, MSG);
    expect(out.ok).toBe(true); // el correo salio
    expect(out.failed[0]?.detail).toContain('400');
  });

  it('reintenta un 429 de Telegram y sale adelante', async () => {
    mockResend(200);
    mockTelegram(429, 1);
    mockTelegram(200, 1);
    const out = await send(DOS, MSG);
    expect(out.delivered.length).toBe(2);
  });
});

describe('contenido del mensaje de Telegram', () => {
  it('lleva tienda, precio y link tocable', async () => {
    let body: any;
    mockResend(200);
    fetchMock
      .get('https://api.telegram.org')
      .intercept({
        path: (p) => p.includes('/sendMessage'),
        method: 'POST',
        body: (raw) => {
          body = JSON.parse(raw);
          return true;
        },
      })
      .reply(200, { ok: true });

    await alertInStock(DOS, fakeStore({ name: 'Best Buy', url: 'https://t.test/ps5' }), {
      status: 'IN_STOCK',
      price: '$899.00',
    });

    expect(body.chat_id).toBe('999');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('Best Buy');
    expect(body.text).toContain('$899.00');
    expect(body.text).toContain('https://t.test/ps5');
    // La vista previa del link empujaria el boton fuera de la pantalla.
    expect(body.disable_web_page_preview).toBe(true);
  });

  it('avisa en el texto cuando el dato es indirecto', async () => {
    let body: any;
    mockResend(200);
    fetchMock
      .get('https://api.telegram.org')
      .intercept({
        path: (p) => p.includes('/sendMessage'),
        method: 'POST',
        body: (raw) => {
          body = JSON.parse(raw);
          return true;
        },
      })
      .reply(200, { ok: true });

    await alertInStock(DOS, fakeStore({ direct: false, source: 'hotstock.io' }), {
      status: 'IN_STOCK',
    });
    expect(body.text).toContain('hotstock.io');
  });
});
