/**
 * Dashboard. Se sirve como string estatico y los datos llegan por /api/status,
 * asi que renderizar la pagina no consume presupuesto de CPU del Worker.
 *
 * La pagina dice tres cosas y nada mas: si hay stock, en que tienda, y cuales
 * fuentes no estan contestando. Todo lo demas —el detalle crudo de cada
 * chequeo, el link a la tienda— vive plegado detras de un click, porque en un
 * drop se mira esto de reojo y un parrafo no se lee.
 */
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor PS5 Pro</title>
<style>
  :root{
    /* Sin esto, el auto-dark de Chrome repinta el tema claro por su cuenta y se
       come los puntos de color, que son justamente lo que hay que leer. */
    color-scheme:light;
    --bg:#f6f7f9; --text:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --hover:#eceef1;
    --chip:#eceef1; --in:#0a7c3f; --out:#9ca3af; --bad:#b42318; --bad-bg:#fdecea; --warn:#a15c00;
  }
  /* Tres estados de tema: el sistema manda salvo que el boton haya elegido. */
  @media (prefers-color-scheme:dark){
    :root:not([data-tema=claro]){
      color-scheme:dark;
      --bg:#111315; --text:#e8eaed; --muted:#9aa1a9; --line:#2c3034; --hover:#1b1e21;
      --chip:#24282c; --in:#4ade80; --out:#6b7280; --bad:#f87171; --bad-bg:#2c1614; --warn:#fbbf24;
    }
  }
  :root[data-tema=oscuro]{
    color-scheme:dark;
    --bg:#111315; --text:#e8eaed; --muted:#9aa1a9; --line:#2c3034; --hover:#1b1e21;
    --chip:#24282c; --in:#4ade80; --out:#6b7280; --bad:#f87171; --bad-bg:#2c1614; --warn:#fbbf24;
  }

  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:inherit;text-decoration:none}
  a:hover{text-decoration:underline}

  .wrap{max-width:680px;margin:0 auto;padding:64px 32px 56px;
        display:flex;flex-direction:column;gap:32px}

  .top{display:flex;align-items:center;justify-content:space-between;gap:16px}
  .marca{display:flex;align-items:baseline;gap:10px}
  h1{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0}
  .cuantas{font-size:13px;color:var(--muted)}
  .tema{display:flex;align-items:center;justify-content:center;width:32px;height:32px;
        padding:0;border:1px solid var(--line);border-radius:8px;background:transparent;
        color:var(--muted);cursor:pointer}
  .tema:hover{background:var(--hover)}
  /* Se muestra el icono del tema al que se va a cambiar. */
  .i-sol{display:none}
  @media (prefers-color-scheme:dark){
    :root:not([data-tema=claro]) .i-sol{display:block}
    :root:not([data-tema=claro]) .i-luna{display:none}
  }
  :root[data-tema=oscuro] .i-sol{display:block}
  :root[data-tema=oscuro] .i-luna{display:none}
  :root[data-tema=claro]{color-scheme:light}
  :root[data-tema=claro] .i-sol{display:none}
  :root[data-tema=claro] .i-luna{display:block}

  .hero{display:flex;align-items:center;justify-content:space-between;gap:40px}
  .titular{font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.15;
           text-wrap:pretty;margin:0 0 6px}
  .titular.hay{color:var(--in)}
  .bajada{font-size:13px;color:var(--muted)}
  .foto{width:84px;height:165px;object-fit:cover;border-radius:12px;flex:none}

  .salud{display:none;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;
         background:var(--bad-bg);color:var(--bad);font-size:13px}
  .salud.on{display:flex}
  .salud svg{flex:none}

  .filtros{display:flex;gap:6px;padding-bottom:10px}
  .chip{padding:5px 12px;border:0;border-radius:999px;font:inherit;font-size:13px;
        background:transparent;color:var(--muted);cursor:pointer}
  .chip:hover{background:var(--hover)}
  .chip.on{background:var(--chip);color:var(--text)}

  .row{border-top:1px solid var(--line);padding:0 8px;cursor:pointer}
  .row:hover{background:var(--hover)}
  .linea{display:flex;align-items:center;gap:14px;padding:14px 4px}
  .punto{width:7px;height:7px;border-radius:999px;background:var(--out);flex:none}
  .punto.IN_STOCK{background:var(--in)}
  .punto.BLOCKED,.punto.ERROR{background:var(--bad)}
  .punto.DISABLED,.punto.PENDING{background:var(--warn)}
  .quien{flex:1;min-width:0;display:flex;align-items:baseline;gap:10px}
  .nombre{font-weight:500}
  .via{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .flag{font-size:12px;font-weight:500;color:var(--bad);white-space:nowrap}
  .flag.IN_STOCK{color:var(--in)}
  .flag.DISABLED,.flag.PENDING{color:var(--warn)}
  .precio{font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}
  .cuando{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;
          width:34px;text-align:right}
  .flecha{color:var(--muted);display:flex;width:14px;opacity:0;transition:opacity .12s}
  .row:hover .flecha{opacity:1}
  .row.abierta .flecha{opacity:1;transform:rotate(90deg)}
  .detalle{display:flex;align-items:center;gap:16px;padding:0 4px 16px 25px;
           font-size:12.5px;color:var(--muted)}
  .crudo{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
         overflow-wrap:anywhere;min-width:0}
  .abrir{text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
  .fin{border-top:1px solid var(--line)}

  .leyenda{display:flex;flex-wrap:wrap;gap:18px;font-size:12px;color:var(--muted)}
  .leyenda span{display:flex;align-items:center;gap:7px}
  .bolita{width:6px;height:6px;border-radius:999px}

  @media (max-width:560px){
    .wrap{padding:40px 20px 40px;gap:26px}
    .hero{gap:20px}
    .titular{font-size:28px}
    .foto{width:56px;height:110px}
    /* En el telefono no hay lugar para columnas: la fuente y el precio pasan
       debajo del nombre y el precio suelto desaparece. */
    .quien{flex-direction:column;align-items:flex-start;gap:1px}
    /* Con el estado a la vista, la fuente sobra: dos lineas por fila, no tres. */
    .quien:has(.flag) .via{display:none}
    .precio{display:none}
    .linea{min-height:56px;gap:13px}
    .leyenda{gap:14px}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <div class="marca">
      <h1>PS5 Pro</h1>
      <span class="cuantas" id="cuantas"></span>
    </div>
    <button class="tema" id="tema" type="button" aria-label="Cambiar tema">
      <svg class="i-sol" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="i-luna" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>
    </button>
  </div>

  <div class="hero">
    <div>
      <p class="titular" id="titular">Cargando</p>
      <p class="bajada" id="bajada"></p>
    </div>
    <img class="foto" src="/ps5pro.jpg" width="84" height="165" alt="PlayStation 5 Pro">
  </div>

  <div class="salud" id="salud">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="9"/></svg>
    <span id="salud-txt"></span>
  </div>

  <div>
    <div class="filtros" id="filtros">
      <button class="chip on" type="button" data-f="todas">Todas</button>
      <button class="chip" type="button" data-f="stock">Con stock</button>
      <button class="chip" type="button" data-f="problemas">Problemas</button>
    </div>
    <div id="lista"></div>
    <div class="fin"></div>
  </div>

  <div class="leyenda">
    <span><i class="bolita" style="background:var(--in)"></i>disponible</span>
    <span><i class="bolita" style="background:var(--out)"></i>agotado</span>
    <span><i class="bolita" style="background:var(--bad)"></i>sin dato, no agotado</span>
  </div>

</div>
<script>
const ORDER = { IN_STOCK:0, BLOCKED:1, ERROR:2, DISABLED:3, PENDING:4, OUT_OF_STOCK:5 };
// El estado agotado no lleva palabra: es el caso normal y el punto gris alcanza.
// Los demas si, porque "bloqueado" no significa lo mismo que "no hay".
const FLAG = {
  IN_STOCK:'DISPONIBLE', BLOCKED:'bloqueado', ERROR:'error',
  DISABLED:'sin API key', PENDING:'esperando'
};
const ROTO = { BLOCKED:1, ERROR:1, DISABLED:1 };

let datos = null, filtro = 'todas', abierta = null;

const $ = (id) => document.getElementById(id);
// El detalle es texto crudo scrapeado: entra a la pagina escapado, siempre.
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

// --- tema ---------------------------------------------------------------
function guardado(){ try { return localStorage.getItem('tema'); } catch { return null; } }
function tema(){
  return guardado() || (matchMedia('(prefers-color-scheme:dark)').matches ? 'oscuro' : 'claro');
}
if (guardado()) document.documentElement.dataset.tema = guardado();
$('tema').onclick = () => {
  const t = tema() === 'oscuro' ? 'claro' : 'oscuro';
  try { localStorage.setItem('tema', t); } catch {}
  document.documentElement.dataset.tema = t;
};

// La fuente real puede no ser la configurada: Best Buy y Newegg caen a terceros
// cuando falta la API key o cuando los bloquean. El detalle del chequeo dice cual
// se uso de verdad, y eso es lo que hay que mostrar.
function srcLabel(s){
  const m = (s.detail || '').match(/via ([a-z.]+)/i);
  if (m) return 'via ' + m[1];
  return s.direct ? '' : 'via ' + s.source;
}

function ago(ts, now){
  if(!ts) return '-';
  const s = Math.max(0, Math.round((now - ts)/1000));
  if(s < 60) return s + 's';
  if(s < 3600) return Math.round(s/60) + 'm';
  return Math.round(s/3600) + 'h';
}

function fila(s, now){
  const flag = FLAG[s.status] || '';
  const via = srcLabel(s);
  const abre = abierta === s.id;
  const detalle = abre
    ? '<div class="detalle"><span class="crudo">' + esc(s.detail || 'sin detalle') + '</span>' +
      '<a class="abrir" href="' + esc(s.url) + '" target="_blank" rel="noopener">abrir tienda</a></div>'
    : '';
  return '<div class="row' + (abre ? ' abierta' : '') + '" data-id="' + esc(s.id) + '">' +
    '<div class="linea">' +
      '<span class="punto ' + esc(s.status) + '"></span>' +
      '<span class="quien">' +
        '<a class="nombre" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' +
        (via ? '<span class="via">' + esc(via) + '</span>' : '') +
        (flag ? '<span class="flag ' + esc(s.status) + '">' + esc(flag) + '</span>' : '') +
      '</span>' +
      '<span class="precio">' + esc(s.price || '—') + '</span>' +
      '<span class="cuando">' + ago(s.checkedAt, now) + '</span>' +
      '<span class="flecha"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
    '</div>' + detalle + '</div>';
}

function pintar(){
  if (!datos) return;
  const now = datos.now;
  const todas = datos.stores.slice().sort((a,b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

  const hay = todas.filter(s => s.status === 'IN_STOCK');
  $('cuantas').textContent = todas.length + ' tiendas';
  $('titular').textContent = hay.length ? 'Disponible en ' + hay[0].name : 'Sin stock';
  $('titular').className = 'titular' + (hay.length ? ' hay' : '');
  $('bajada').textContent = hay.length
    ? 'Visto hace ' + ago(hay[0].checkedAt, now)
    : 'Chequeando cada 60 s';

  const ver = filtro === 'stock' ? hay
    : filtro === 'problemas' ? todas.filter(s => ROTO[s.status])
    : todas;
  $('lista').innerHTML = ver.map(s => fila(s, now)).join('');
}

$('filtros').onclick = (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filtro = b.dataset.f;
  abierta = null;
  for (const c of $('filtros').children) c.classList.toggle('on', c === b);
  pintar();
};

// Click en la fila abre el detalle; click en un link va a la tienda y no la abre.
$('lista').onclick = (e) => {
  if (e.target.closest('a')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  abierta = abierta === row.dataset.id ? null : row.dataset.id;
  pintar();
};

// El monitor puede estar mirando bien y aun asi no poder avisarte. Esta franja
// solo aparece cuando algo del canal de alertas esta roto: correo rechazado,
// chequeos congelados o todas las tiendas ciegas. Si no se ve, esta todo bien.
async function salud(){
  const box = $('salud');
  let h;
  try { h = await (await fetch('/health')).json(); }
  catch { return; }

  if (h.ok) { box.className = 'salud'; return; }

  const partes = [];
  if (h.stale) partes.push('No chequea hace ' + Math.round((h.lastCheckAgeSec ?? 0)/60) + ' min.');
  if (h.lastEmailFailure) partes.push('El ultimo correo no salio.');
  if (h.storesBlind >= h.storesTracked) partes.push('Ninguna tienda esta devolviendo estado.');
  $('salud-txt').textContent = (partes.join(' ') || 'El monitor no esta sano.') + ' Podria no avisarte.';
  box.className = 'salud on';
}

async function load(){
  try { datos = await (await fetch('/api/status')).json(); }
  catch {
    $('titular').textContent = 'Sin conexion';
    $('bajada').textContent = 'No se pudo hablar con el monitor.';
    return;
  }
  pintar();
}

load(); salud();
setInterval(load, 15000);
setInterval(salud, 30000);
</script>
</body>
</html>`;
}
