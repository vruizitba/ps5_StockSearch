-- Auditoria de cada intento de correo.
--
-- Antes, un fallo de Resend solo dejaba un console.error que se perdia con el
-- isolate: no habia forma de saber, mirando la app, si una alerta habia salido
-- de verdad. Esta tabla convierte ese silencio en un dato consultable.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   TEXT    NOT NULL,   -- id de tienda, o '-' para pruebas y avisos globales
  kind       TEXT    NOT NULL,   -- IN_STOCK | UNHEALTHY | TEST | CLOCK_GAP
  ok         INTEGER NOT NULL,   -- 1 si al menos un destinatario acepto el mail
  detail     TEXT,               -- destinatarios que fallaron y por que
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(created_at DESC);
