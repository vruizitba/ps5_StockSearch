-- Historial de chequeos. Una fila por tienda por ciclo.
CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   TEXT    NOT NULL,
  status     TEXT    NOT NULL,   -- IN_STOCK | OUT_OF_STOCK | BLOCKED | ERROR | DISABLED
  price      TEXT,
  detail     TEXT,               -- mensaje de error o senal cruda observada
  checked_at INTEGER NOT NULL    -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_checks_store_time ON checks(store_id, checked_at DESC);

-- Estado vigente por tienda. Una fila por tienda.
-- Separado de checks para que /api/status sea una sola lectura barata.
CREATE TABLE IF NOT EXISTS store_state (
  store_id        TEXT PRIMARY KEY,
  status          TEXT    NOT NULL,
  price           TEXT,
  detail          TEXT,
  checked_at      INTEGER NOT NULL,
  -- Deduplicacion de alertas de stock
  last_notified_at INTEGER,
  -- Backoff ante bloqueos
  fail_streak     INTEGER NOT NULL DEFAULT 0,
  next_check_at   INTEGER NOT NULL DEFAULT 0,
  -- Aviso de scraper roto, para no repetirlo
  health_alerted_at INTEGER
);
