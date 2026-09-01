import type { Env, StockResult, StoreState, Status } from './types';

export async function getState(env: Env, storeId: string): Promise<StoreState | null> {
  return env.DB.prepare('SELECT * FROM store_state WHERE store_id = ?')
    .bind(storeId)
    .first<StoreState>();
}

export async function allStates(env: Env): Promise<StoreState[]> {
  const { results } = await env.DB.prepare('SELECT * FROM store_state').all<StoreState>();
  return results ?? [];
}

/**
 * Guarda el resultado de un chequeo y devuelve el estado anterior.
 *
 * El backoff solo se aplica a BLOCKED y ERROR. Insistir cada minuto contra un
 * muro no consigue el dato y empeora la reputacion de la IP.
 */
export async function recordCheck(
  env: Env,
  storeId: string,
  result: StockResult,
  intervalSec: number,
): Promise<StoreState | null> {
  const now = Date.now();
  const prev = await getState(env, storeId);

  const failed = result.status === 'BLOCKED' || result.status === 'ERROR';
  const streak = failed ? (prev?.fail_streak ?? 0) + 1 : 0;

  // Backoff exponencial con techo de 30 min.
  const backoffSec = failed
    ? Math.min(intervalSec * 2 ** Math.min(streak, 6), 1800)
    : intervalSec;
  const nextCheckAt = now + backoffSec * 1000;

  const statements = [
    env.DB.prepare(
      'INSERT INTO checks (store_id, status, price, detail, checked_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(storeId, result.status, result.price ?? null, result.detail ?? null, now),
    env.DB.prepare(
      `INSERT INTO store_state
         (store_id, status, price, detail, checked_at, fail_streak, next_check_at,
          last_notified_at, health_alerted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(store_id) DO UPDATE SET
         status = excluded.status,
         price = excluded.price,
         detail = excluded.detail,
         checked_at = excluded.checked_at,
         fail_streak = excluded.fail_streak,
         next_check_at = excluded.next_check_at`,
    ).bind(
      storeId,
      result.status,
      result.price ?? null,
      result.detail ?? null,
      now,
      streak,
      nextCheckAt,
    ),
  ];

  await env.DB.batch(statements);
  return prev;
}

export async function markNotified(env: Env, storeId: string): Promise<void> {
  await env.DB.prepare('UPDATE store_state SET last_notified_at = ? WHERE store_id = ?')
    .bind(Date.now(), storeId)
    .run();
}

export async function markHealthAlerted(env: Env, storeId: string): Promise<void> {
  await env.DB.prepare('UPDATE store_state SET health_alerted_at = ? WHERE store_id = ?')
    .bind(Date.now(), storeId)
    .run();
}

export async function clearHealthAlert(env: Env, storeId: string): Promise<void> {
  await env.DB.prepare('UPDATE store_state SET health_alerted_at = NULL WHERE store_id = ?')
    .bind(storeId)
    .run();
}

export interface HistoryRow {
  store_id: string;
  status: Status;
  price: string | null;
  detail: string | null;
  checked_at: number;
}

export async function history(env: Env, hours: number): Promise<HistoryRow[]> {
  const since = Date.now() - hours * 3600_000;
  const { results } = await env.DB.prepare(
    'SELECT store_id, status, price, detail, checked_at FROM checks WHERE checked_at > ? ORDER BY checked_at DESC LIMIT 2000',
  )
    .bind(since)
    .all<HistoryRow>();
  return results ?? [];
}

export interface BlockRate {
  store_id: string;
  total: number;
  blocked: number;
  errored: number;
  rate: number;
}

/** Tasa de fallas por tienda: el numero que dice si una fuente esta podrida. */
export async function blockRate(env: Env, hours: number): Promise<BlockRate[]> {
  const since = Date.now() - hours * 3600_000;
  const { results } = await env.DB.prepare(
    `SELECT store_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN status = 'ERROR'   THEN 1 ELSE 0 END) AS errored
       FROM checks
      WHERE checked_at > ?
      GROUP BY store_id`,
  )
    .bind(since)
    .all<{ store_id: string; total: number; blocked: number; errored: number }>();

  return (results ?? []).map((r) => ({
    ...r,
    rate: r.total ? (r.blocked + r.errored) / r.total : 0,
  }));
}

/** Poda el historial. Sin esto D1 crece sin techo. */
export async function prune(env: Env, keepDays = 30): Promise<void> {
  await env.DB.prepare('DELETE FROM checks WHERE checked_at < ?')
    .bind(Date.now() - keepDays * 86400_000)
    .run();
}
