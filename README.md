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
hasta 7 intentos con 300 ms entre uno y otro; cada uno sale por otra IP y suele
pasar en el segundo o el tercero.

Aun así falla una parte de los chequeos (`GET /api/blockrate`), y ningún tercero
lo cubre: ni hotstock ni nowinstock listan PlayStation Direct para la Pro 2TB.

**El volumen sí importa, medido.** Se probó quitarle el backoff a esta tienda,
razonando que su 403 es IP de salida marcada y no límite de frecuencia. Con eso
pasa a recibir 7 pedidos por minuto de forma sostenida mientras dure un bloqueo,
y el bloqueo trepó del 3 % al 80 % en hora y media. La conclusión es la
contraria: insistir se paga. El backoff quedó puesto, y además el esfuerzo por
chequeo se modula — 7 intentos con la tienda sana, 2 cuando ya lleva 3 fallas
seguidas, porque ahí solo hace falta detectar que se recuperó.

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

## Que el aviso llegue

El monitor puede mirar bien y aun así no avisarte. Esa es la falla cara, y es la
que más trabajo tiene encima.

**Dos canales, no uno.** La alerta sale por correo (Resend) y por Telegram en
paralelo, y se considera entregada si la acepta **al menos uno**. Depender de un
solo proveedor era el último punto único de falla: los tres vigilantes detectan
el problema, pero si el único canal está caído, ninguno te lo puede contar. Un
canal sin credenciales se saltea en silencio; con ninguno configurado, el envío
falla explícito. `GET /health` lista los canales vivos.

Telegram además llega antes: un push aparece en un segundo, mientras que un mail
puede quedar unos minutos en cola. Un drop dura minutos.

**El envío no se da por hecho.** Cada alerta se manda con hasta 3 intentos: un
5xx, un 429 o un corte de red se reintentan; un 4xx no, porque repetirlo da el
mismo error. Solo si Resend acepta se marca la tienda como notificada. Antes se
marcaba siempre: un rechazo activaba igual el silencio de 6 horas y la alerta no
se reintentaba nunca. Hoy, un envío fallido se vuelve a intentar al ciclo
siguiente, un minuto después.

**Un destinatario por pedido (correo).** Resend valida la lista entera antes de mandar: con
una sola dirección que no acepte, rechaza el pedido completo con 422 y no le llega
a nadie. Mandando de a uno, una dirección rota solo se pierde a sí misma.

**Queda registro.** Cada intento va a la tabla `notifications`, con el error de
Resend si lo hubo. `GET /api/notifications` lo lista y el dashboard muestra una
franja roja si el último correo no salió.

**Ensayo cuando quieras.** `POST /api/simulate?token=` manda la alerta real de
stock por todos los canales —misma plantilla, mismo remitente, mismos
destinatarios— sin esperar a que haya stock. No toca la base, así que no puede
silenciar una alerta de verdad.

> Con el remitente `onboarding@resend.dev` (el de prueba de Resend) solo se puede
> mandar a la casilla dueña de la cuenta. Para sumar destinatarios hay que
> verificar un dominio propio en Resend y cambiar `FROM_EMAIL`.

**Si el reloj se para.** Es la única falla de la que la app no puede avisar sola:
si dejó de correr, no hay nadie adentro para mandar el mail. Tres defensas:

1. La alarma se reprograma **antes** de trabajar, así que un ciclo que explota no
   corta la cadena.
2. Si una alarma pendiente quedó vencida hace más de 3 minutos, se considera
   trabada y cualquier petición al Worker la vuelve a armar.
3. Cuando el reloj arranca después de un hueco de más de 5 minutos, manda un mail
   diciendo cuánto tiempo estuvo ciego. El silencio no puede pasar por "no hubo
   stock".

Para cubrir el caso de que el Worker entero deje de responder, `GET /health`
devuelve **503** si hace más de 5 minutos que no se chequea nada, si el último
correo falló, o si todas las tiendas están ciegas.

Contra eso vigila `.github/workflows/watchdog.yml`, que corre en GitHub —fuera de
Cloudflare— cada 5 minutos. Consulta `/health` dos veces separadas por 30 s (un
solo fallo puede ser un hipo de red) y, si las dos fallan, manda el mail **él
mismo** vía Resend, sin pasar por el Worker caído, y además marca la corrida como
fallida para que salte también la notificación propia de GitHub.

No repite el aviso: si la corrida anterior ya había fallado, se saltea el mail. Un
vigilante que manda doce mails por hora se termina silenciando, y un vigilante
silenciado no vigila.

Necesita dos cosas cargadas en el repo, ya configuradas:

```bash
gh secret set RESEND_API_KEY     # la misma key que usa el Worker
gh variable set ALERT_EMAILS --body "tu@correo.com"
```

**Ensayar la alarma.** El camino sano no prueba nada del camino que importa. El
workflow acepta una URL de override para forzar el fallo sin esperar a que el
Worker se caiga:

```bash
gh workflow run watchdog.yml \
  -f health_url="https://ps5-stock-monitor.valenruiz2004-c85.workers.dev/no-existe"
```

Tiene que terminar en `failure` y mandarte el mail. Ese ensayo encontró tres
fallas que el camino sano había dado por buenas: la consulta de deduplicación
corría sin `--repo` y fallaba en silencio (el job no hace `checkout`, así que
`gh` no tenía contexto), y Resend devolvía 403 porque `urllib` manda
`Python-urllib/3.x` como User-Agent y lo rechaza.

> **Punto débil conocido:** GitHub desactiva los `cron` de repos sin actividad
> durante 60 días, y atrasa los horarios bajo carga. Por eso conviene sumar
> además un monitor dedicado (UptimeRobot, cron-job.org) apuntando a la misma
> URL de `/health`: son cinco minutos y no tiene ninguno de esos dos problemas.

## Tests

```bash
npm test          # 80 tests
npm run typecheck
```

Corren sobre **workerd de verdad** (`@cloudflare/vitest-pool-workers`): D1,
Durable Objects y `HTMLRewriter` son los del runtime real, no simulaciones. Lo
único mockeado es la red saliente.

| Archivo | Qué cubre |
|---|---|
| `test/notify.test.ts` | Reintentos, 4xx sin reintento, un destinatario roto no tumba a los demás, escapado de HTML |
| `test/channels.test.ts` | Un canal caído no impide que el otro entregue; solo fallando los dos la alerta se reintenta |
| `test/cycle.test.ts` | Alerta al aparecer stock, **reintento si el mail no salió**, cooldown, techo del backoff, aviso de fuente rota |
| `test/stores.test.ts` | Mapeo de estados de PlayStation y Best Buy; 403 y JSON roto dan `BLOCKED`/`ERROR`, jamás "sin stock" |
| `test/parsers.test.ts` | hotstock y nowinstock contra **HTML real capturado del sitio**, incluida una fila con stock de verdad |
| `test/ticker.test.ts` | Armado, alarma trabada, orden de reprogramación, aviso de hueco |
| `test/routes.test.ts` | Token en las rutas que actúan, `/health` en cada modo de falla |

Las capturas de HTML están en `test/fixtures/`. Para refrescarlas cuando un sitio
cambie, ver las instrucciones en `test/fixtures/build.mjs`.

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

# Telegram como segundo canal (opcional pero recomendado):
# 1. @BotFather -> /newbot -> te da el token
# 2. escribile al bot una vez: no puede iniciar la conversacion el
# 3. el chat id sale de https://api.telegram.org/bot<TOKEN>/getUpdates
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

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

Para probar que la alerta de stock llega de verdad, sin esperar un drop:

```bash
curl -X POST "http://127.0.0.1:8787/api/simulate?token=TU_ADMIN_TOKEN"
```

## Rutas

| Ruta | Qué hace |
|---|---|
| `GET /` | Dashboard |
| `GET /ps5pro.jpg` | Foto de la consola del dashboard, embebida en el bundle |
| `GET /api/status` | Estado actual de las 7 tiendas |
| `GET /api/history?hours=24` | Historial crudo |
| `GET /api/blockrate?hours=168` | Tasa de fallas por tienda |
| `GET /health` | Salud: 503 si está viejo, ciego o el correo falla |
| `GET /api/notifications` | Historial de correos enviados y rechazados |
| `POST /api/check/:id?token=` | Fuerza el chequeo de una tienda |
| `GET`/`POST` `/api/run?token=` | Fuerza un ciclo completo |
| `POST /api/test-email?token=` | Manda un mail de prueba |
| `POST /api/simulate?token=&store=` | Ensaya la alerta de stock real |

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
