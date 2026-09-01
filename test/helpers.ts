import { env, fetchMock } from 'cloudflare:test';
import type { StockResult } from '../src/types';
import type { StoreMeta } from '../src/stores/index';

/** Deja la base limpia entre tests: sin esto el estado de uno contamina al otro. */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM store_state'),
    env.DB.prepare('DELETE FROM checks'),
    env.DB.prepare('DELETE FROM notifications'),
  ]);
}

/** Tienda de mentira con resultado fijo: aisla el ciclo de la red. */
export function fakeStore(over: Partial<StoreMeta> & { result?: StockResult }): StoreMeta {
  const result = over.result ?? { status: 'OUT_OF_STOCK' };
  return {
    id: 'fake',
    name: 'Tienda Falsa',
    url: 'https://ejemplo.test/producto',
    intervalSec: 60,
    direct: true,
    source: 'test',
    check: async () => result,
    ...over,
  };
}

/** Intercepta la API de Resend y devuelve el status pedido, `times` veces. */
export function mockResend(status: number, times = 1, body: unknown = { id: 'msg_1' }): void {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: '/emails', method: 'POST' })
    .reply(status, body)
    .times(times);
}

export async function notificationRows(): Promise<
  Array<{ store_id: string; kind: string; ok: number; detail: string | null }>
> {
  const { results } = await env.DB.prepare(
    'SELECT store_id, kind, ok, detail FROM notifications ORDER BY id',
  ).all<{ store_id: string; kind: string; ok: number; detail: string | null }>();
  return results ?? [];
}

export async function stateOf(storeId: string) {
  return env.DB.prepare('SELECT * FROM store_state WHERE store_id = ?')
    .bind(storeId)
    .first<Record<string, number | string | null>>();
}
