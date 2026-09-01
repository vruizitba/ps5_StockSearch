import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { send, esc, recipients, alertInStock } from '../src/notify';
import type { AlertMessage } from '../src/channels/types';
import { fakeStore, mockResend } from './helpers';

const MSG: AlertMessage = { subject: 'asunto', html: '<p>hola</p>', text: 'hola' };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('envio de correo', () => {
  it('reporta exito solo cuando Resend acepta', async () => {
    mockResend(200);
    const out = await send(env, MSG);
    expect(out.ok).toBe(true);
    expect(out.delivered).toEqual(['uno@ejemplo.test']);
    expect(out.failed).toEqual([]);
  });

  it('NO reporta exito cuando Resend rechaza', async () => {
    // Este es el bug que costaba el stock: antes send() se tragaba el error y
    // la app marcaba la alerta como enviada.
    mockResend(422, 1, { message: 'Invalid `to` field' });
    const out = await send(env, MSG);
    expect(out.ok).toBe(false);
    expect(out.failed[0]?.detail).toContain('422');
  });

  it('no reintenta un 4xx: repetirlo da el mismo error', async () => {
    // Un solo interceptor. Si reintentara, el segundo pedido no tendria a quien
    // pegarle y el test fallaria por conexion no interceptada.
    mockResend(422, 1);
    const out = await send(env, MSG);
    expect(out.ok).toBe(false);
  });

  it('reintenta un 5xx y sale adelante', async () => {
    mockResend(500, 1);
    mockResend(200, 1);
    const out = await send(env, MSG);
    expect(out.ok).toBe(true);
  });

  it('reintenta un 429 y sale adelante', async () => {
    mockResend(429, 1);
    mockResend(200, 1);
    const out = await send(env, MSG);
    expect(out.ok).toBe(true);
  });

  it('se rinde tras 3 intentos seguidos de 5xx', async () => {
    mockResend(503, 3);
    const out = await send(env, MSG);
    expect(out.ok).toBe(false);
    expect(out.failed[0]?.detail).toContain('503');
  });

  it('una direccion rota no se lleva puestas a las demas', async () => {
    // Resend valida la lista entera: con un solo `to` invalido rechaza el
    // pedido completo y no le llega a nadie. Por eso se manda uno por uno.
    const multi = { ...env, ALERT_EMAILS: 'bueno@ejemplo.test, roto@example.com' };
    mockResend(200, 1);
    mockResend(422, 1, { message: 'Invalid `to` field' });
    const out = await send(multi, MSG);
    expect(out.ok).toBe(true);
    expect(out.delivered.length).toBe(1);
    expect(out.failed.length).toBe(1);
  });

  it('sin ningun canal configurado falla explicito, no en silencio', async () => {
    const pelado = { ...env, RESEND_API_KEY: '', TELEGRAM_BOT_TOKEN: '' };
    const out = await send(pelado, MSG);
    expect(out.ok).toBe(false);
    expect(out.channels).toEqual([]);
    expect(out.failed[0]?.detail).toContain('ningun canal');
  });

  it('sin destinatarios de correo no usa el canal de correo', async () => {
    const sinDest = { ...env, ALERT_EMAILS: '  ,  ', TELEGRAM_BOT_TOKEN: '' };
    const out = await send(sinDest, MSG);
    expect(out.ok).toBe(false);
    expect(out.channels).toEqual([]);
  });

  it('parsea la lista de destinatarios tolerando espacios y vacios', () => {
    expect(recipients({ ...env, ALERT_EMAILS: ' a@b.test , , c@d.test ' })).toEqual([
      'a@b.test',
      'c@d.test',
    ]);
  });

  it('escapa el HTML para que un detalle raro no rompa el mail', () => {
    expect(esc('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });
});

describe('mail de alerta', () => {
  it('lleva tienda, precio y link en el cuerpo', async () => {
    let body: any;
    fetchMock
      .get('https://api.resend.com')
      .intercept({
        path: '/emails',
        method: 'POST',
        body: (raw) => {
          body = JSON.parse(raw);
          return true;
        },
      })
      .reply(200, { id: 'x' });

    const store = fakeStore({ name: 'Best Buy', url: 'https://tienda.test/ps5' });
    const out = await alertInStock(env, store, {
      status: 'IN_STOCK',
      price: '$899.00',
      detail: 'onlineAvailability=true',
    });

    expect(out.ok).toBe(true);
    expect(body.subject).toContain('DISPONIBLE en Best Buy');
    expect(body.subject).toContain('$899.00');
    expect(body.html).toContain('https://tienda.test/ps5');
    expect(body.to).toEqual(['uno@ejemplo.test']);
    expect(body.from).toBe('monitor@ejemplo.test');
  });

  it('avisa en el cuerpo cuando el dato es indirecto', async () => {
    let body: any;
    fetchMock
      .get('https://api.resend.com')
      .intercept({
        path: '/emails',
        method: 'POST',
        body: (raw) => {
          body = JSON.parse(raw);
          return true;
        },
      })
      .reply(200, { id: 'x' });

    await alertInStock(env, fakeStore({ direct: false, source: 'hotstock.io' }), {
      status: 'IN_STOCK',
    });
    expect(body.html).toContain('Dato indirecto via hotstock.io');
  });
});
