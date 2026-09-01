# ps5_StockSearch

Monitor de stock de la **PlayStation 5 Pro** en tiendas de Estados Unidos.
Chequea cada minuto y manda un mail apenas aparece stock, con tienda, precio y
link directo. Corre entero en Cloudflare Workers: gratis, sin servidor propio y
sin dejar ninguna computadora prendida.

## Tiendas y de dónde sale el dato

| Tienda | Fuente | Tipo |
|---|---|---|
| PlayStation Direct | `api.direct.playstation.com` (SAP Commerce) | directa |
| Best Buy | API oficial de Best Buy | directa |
| Newegg | API `ProductRealtime`, con respaldo en nowinstock.net | mixta |
| Amazon | hotstock.io | indirecta |
| Walmart | hotstock.io | indirecta |
| Target | hotstock.io | indirecta |
| GameStop | hotstock.io | indirecta |

**Por qué algunas son indirectas.** Walmart, Target y GameStop devuelven muros
anti-bot a un pedido normal, y Amazon arma su botón de compra con JavaScript, así
que parsear su HTML daría falsos positivos. hotstock.io ya monitorea las cuatro y
publica el estado en HTML plano. Es un tercero: no controlamos su frecuencia ni su
continuidad, y la latencia es la de ellos más la nuestra. El dashboard las marca
como indirectas y el mail lo aclara.

**Newegg es mixta.** Su API `ProductRealtime` devuelve JSON limpio a un pedido
desde una conexión residencial, pero responde 403 a las IPs de Cloudflare. El
chequeo intenta la API primero y cae a nowinstock.net cuando lo bloquean, así que
el código sigue sirviendo si alguna vez esto corre desde una IP casera.

**PlayStation Direct sí es directa.** Su página está detrás de Akamai y no trae el
stock — sirve todos los estados ocultos y deja que su JavaScript decida. Pero el
host de API (`api.direct.playstation.com`) no está protegido y devuelve el mismo
campo `stock.stockLevelStatus` que consume el sitio.

## Los cuatro estados

```
IN_STOCK      hay stock  ->  dispara mail
OUT_OF_STOCK  agotado
BLOCKED       muro anti-bot, 403, captcha
ERROR         timeout, JSON inválido, el HTML ya no matchea
DISABLED      falta una API key
```

`BLOCKED` y `ERROR` **nunca** se cuentan como "sin stock". Es la decisión central
del diseño: si un scraper roto se reportara como "agotado", el silencio se
confundiría con "todavía no hay" y no te enterarías de que quedaste ciego. Cuando
una tienda falla 30 minutos seguidos, llega un mail de aviso.

## Puesta en marcha

```bash
npm install

# 1. Base de datos
npx wrangler d1 create ps5_stock
# copiar el database_id que imprime a wrangler.toml

# 2. Tablas
npm run migrate:remote

# 3. Secrets (quedan cifrados en Cloudflare, nunca en el repo)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BESTBUY_API_KEY   # opcional, ver abajo
npx wrangler secret put ADMIN_TOKEN       # string largo y aleatorio

# 4. Destinatarios: editar ALERT_EMAILS en wrangler.toml (separados por coma)

# 5. Deploy
npm run deploy
```

### Desarrollo local

```bash
cp .dev.vars.example .dev.vars    # .dev.vars está en .gitignore
npm run migrate:local
npm run dev
```

Miniflare no dispara el cron solo. Para correr un ciclo a mano:

```bash
curl -X POST "http://127.0.0.1:8787/api/run?token=TU_ADMIN_TOKEN"
```

## Rutas

| Ruta | Qué hace |
|---|---|
| `GET /` | Dashboard |
| `GET /api/status` | Estado actual de las 7 tiendas |
| `GET /api/history?hours=24` | Historial crudo |
| `GET /api/blockrate?hours=168` | Tasa de fallas por tienda |
| `GET /health` | Liveness |
| `POST /api/check/:id?token=` | Fuerza el chequeo de una tienda |
| `POST /api/run?token=` | Fuerza un ciclo completo |
| `POST /api/test-email?token=` | Manda un mail de prueba |

Las rutas `POST` piden `ADMIN_TOKEN`: la página es pública y sin eso cualquiera
podría gastar el presupuesto o disparar mails.

## API key de Best Buy

Se pide gratis en [developer.bestbuy.com](https://developer.bestbuy.com) y puede
demorar días. Sin ella, Best Buy queda en `DISABLED` y las otras seis tiendas
funcionan igual. Cargala cuando llegue con `wrangler secret put BESTBUY_API_KEY`.

## Costos

Todo entra en el plan gratuito: 1.440 invocaciones de cron por día contra un
límite de 100.000, y unas 4.300 escrituras en D1 contra 100.000.

El límite ajustado es el de **10 ms de CPU por invocación**. Por eso el HTML de
hotstock se parsea con `HTMLRewriter`, que trabaja en streaming del lado de Rust
en vez de cargar el documento entero en memoria.

## Mantenimiento

Los IDs de producto están en `src/stores/index.ts` y en cada archivo de tienda.
Si una tienda rediseña su sitio o cambia el listado, el chequeo pasa a `ERROR`
(nunca a "sin stock") y llega el mail de aviso. `GET /api/blockrate` muestra qué
fuente se está degradando.
