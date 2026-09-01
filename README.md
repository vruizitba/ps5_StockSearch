# ps5_StockSearch

Monitor de stock de la **PlayStation 5 Pro** en tiendas de Estados Unidos.
Chequea cada minuto y manda un mail apenas aparece stock, con tienda, precio y
link directo. Corre entero en Cloudflare Workers: gratis, sin servidor propio y
sin dejar ninguna computadora prendida.

## Tiendas y de dónde sale el dato

| Tienda | Fuente | Tipo |
|---|---|---|
| PlayStation Direct | `api.direct.playstation.com` (SAP Commerce) | directa |
| Best Buy | API oficial, con respaldo en hotstock.io | mixta |
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

**PlayStation Direct reintenta.** Sony devuelve 403 de forma intermitente a las
IPs de Cloudflare: algunas de sus IPs de salida están marcadas y otras no, así que
el mismo pedido pasa o falla según cuál le toque. No es límite de frecuencia —
diez consultas seguidas desde una conexión residencial dan 200. El chequeo hace
hasta 4 intentos; cada uno sale por otra IP y suele pasar en el segundo.

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
| `GET`/`POST` `/api/run?token=` | Fuerza un ciclo completo |
| `POST /api/test-email?token=` | Manda un mail de prueba |

Las rutas `POST` piden `ADMIN_TOKEN`: la página es pública y sin eso cualquiera
podría gastar el presupuesto o disparar mails.

## Qué dispara los chequeos

No es el cron de Cloudflare. En esta cuenta quedó registrado y aparece en
`/schedules`, pero nunca disparó: seis minutos de `wrangler tail` capturaron 196
invocaciones `fetch` y cero programadas. Es un problema conocido en cuentas nuevas.

En su lugar hay un **Durable Object con alarma** (`src/ticker.ts`) que se
reprograma solo cada 60 segundos. Es otro mecanismo, funciona, y queda todo dentro
de Cloudflare sin depender de servicios externos.

La alarma se arma sola en la primera petición que reciba el Worker, así que si la
cadena alguna vez se corta, basta abrir el dashboard. Para verla o forzarla:

```
GET /api/ticker    ->  {"armed":false,"nextAlarm":1788286875778}
```

La próxima alarma se programa **antes** de correr el ciclo: si un chequeo explota,
el reloj sobrevive. Al revés, un error dejaría el monitor muerto en silencio.

Queda además `GET|POST /api/run?token=` como disparador manual o para un cron
externo, por si algún día hace falta. Es idempotente: `next_check_at` evita repetir
chequeos ya hechos.

## API key de Best Buy

**No es obligatoria.** Sin ella, Best Buy se monitorea igual a través de hotstock.io.
Lo que aporta la key es el precio, que hotstock no publica, y un dato de primera
mano en vez de uno de tercero.

Se pide gratis en [developer.bestbuy.com](https://developer.bestbuy.com) y puede
demorar días. Cargala cuando llegue con `wrangler secret put BESTBUY_API_KEY`; el
chequeo pasa solo a usar la API, sin redeploy.

## Precios

Aparecen solo donde la fuente los publica:

| Tienda | Precio | Por qué |
|---|---|---|
| PlayStation Direct | sí | la API lo devuelve |
| Newegg | sí | nowinstock.net lo publica |
| Best Buy | con API key | hotstock no publica precios |
| Amazon, Walmart, Target, GameStop | no | hotstock no publica precios |

Amazon tampoco sirve para esto de forma directa: su página no trae el precio ni el
estado en el HTML del servidor, los carga con JavaScript.

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
