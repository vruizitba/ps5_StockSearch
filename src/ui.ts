/**
 * Dashboard. Se sirve como string estatico y los datos llegan por /api/status,
 * asi que renderizar la pagina no consume presupuesto de CPU del Worker.
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
    --bg:#f6f7f9; --card:#fff; --text:#1a1d21; --muted:#6b7280; --line:#e5e7eb;
    --in:#0a7c3f; --in-bg:#e6f5ec; --out:#6b7280; --out-bg:#f1f2f4;
    --bad:#b42318; --bad-bg:#fdecea; --warn:#a15c00; --warn-bg:#fdf3e3;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#111315; --card:#1b1e21; --text:#e8eaed; --muted:#9aa1a9; --line:#2c3034;
      --in:#4ade80; --in-bg:#0f2b1c; --out:#9aa1a9; --out-bg:#24282c;
      --bad:#f87171; --bad-bg:#2c1614; --warn:#fbbf24; --warn-bg:#2b2113;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:28px 18px 60px}
  h1{font-size:24px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 24px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .row{display:flex;align-items:center;gap:14px;padding:14px 16px;border-top:1px solid var(--line)}
  .row:first-child{border-top:none}
  .name{font-weight:600;flex:1;min-width:0}
  .name a{color:inherit;text-decoration:none}
  .name a:hover{text-decoration:underline}
  .src{display:block;font-weight:400;font-size:12px;color:var(--muted);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .price{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
  .badge{font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;white-space:nowrap}
  .IN_STOCK{color:var(--in);background:var(--in-bg)}
  .OUT_OF_STOCK{color:var(--out);background:var(--out-bg)}
  .BLOCKED,.ERROR{color:var(--bad);background:var(--bad-bg)}
  .DISABLED,.PENDING{color:var(--warn);background:var(--warn-bg)}
  .when{color:var(--muted);font-size:12px;white-space:nowrap;min-width:72px;text-align:right}
  .note{margin-top:18px;color:var(--muted);font-size:13px}
  .health{display:none;margin:0 0 18px;padding:12px 14px;border-radius:10px;
          font-size:14px;background:var(--bad-bg);color:var(--bad);
          border:1px solid currentColor}
  .health.on{display:block}
  .note code{background:var(--out-bg);padding:1px 5px;border-radius:4px}
  @media (max-width:560px){ .price,.when{display:none} }
</style>
</head>
<body>
<div class="wrap">
  <h1>Monitor PS5 Pro</h1>
  <p class="sub" id="sub">Cargando...</p>
  <div class="health" id="health"></div>
  <div class="card" id="list"></div>
  <p class="note">
    Las tiendas marcadas <em>via</em> son datos de terceros y pueden llegar con
    retraso. <code>bloqueado</code> y <code>error</code> significan que no pudimos
    leer esa tienda &mdash; <strong>no</strong> que no haya stock.
  </p>
  <p class="note">
    El precio aparece solo donde la fuente lo publica: PlayStation Direct y Newegg
    lo dan, hotstock.io no. Best Buy lo mostrar&aacute; cuando est&eacute; cargada
    su API key. Un gui&oacute;n significa que esa fuente no informa precio, no que
    el producto no tenga.
  </p>
</div>
<script>
const ORDER = { IN_STOCK:0, BLOCKED:1, ERROR:2, DISABLED:3, PENDING:4, OUT_OF_STOCK:5 };
const LABEL = {
  IN_STOCK:'DISPONIBLE', OUT_OF_STOCK:'agotado', BLOCKED:'bloqueado',
  ERROR:'error', DISABLED:'sin API key', PENDING:'esperando'
};

// La fuente real puede no ser la configurada: Best Buy y Newegg caen a terceros
// cuando falta la API key o cuando los bloquean. El detalle del chequeo dice cual
// se uso de verdad, y eso es lo que hay que mostrar.
function srcLabel(s){
  const d = s.detail || '';
  const m = d.match(/via ([a-z.]+)/i);
  if (m) return 'via ' + m[1];
  return s.direct ? s.source : 'via ' + s.source;
}

function ago(ts, now){
  if(!ts) return '-';
  const s = Math.max(0, Math.round((now - ts)/1000));
  if(s < 60) return s + 's';
  if(s < 3600) return Math.round(s/60) + 'm';
  return Math.round(s/3600) + 'h';
}

// El monitor puede estar mirando bien y aun asi no poder avisarte. Esta franja
// solo aparece cuando algo del canal de alertas esta roto: correo rechazado,
// chequeos congelados o todas las tiendas ciegas. Si no se ve, esta todo bien.
async function health(){
  const box = document.getElementById('health');
  let h;
  try { h = await (await fetch('/health')).json(); }
  catch { return; }

  if (h.ok) { box.className = 'health'; return; }

  const partes = [];
  if (h.stale) partes.push('El monitor no chequea hace ' + Math.round((h.lastCheckAgeSec ?? 0)/60) + ' min.');
  if (h.lastEmailFailure) partes.push('El ultimo correo no salio: ' + (h.lastEmailFailure.detail || 'sin detalle'));
  if (h.storesBlind >= 7) partes.push('Ninguna tienda esta devolviendo estado.');
  box.textContent = partes.join(' ') || 'El monitor no esta sano.';
  box.className = 'health on';
}

async function load(){
  let d;
  try { d = await (await fetch('/api/status')).json(); }
  catch { document.getElementById('sub').textContent = 'Sin conexion con el monitor.'; return; }

  const stores = d.stores.slice().sort((a,b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

  const hay = stores.filter(s => s.status === 'IN_STOCK');
  document.getElementById('sub').textContent = hay.length
    ? 'DISPONIBLE en: ' + hay.map(s => s.name).join(', ')
    : 'Sin stock en ninguna tienda. Chequeando cada minuto.';

  document.getElementById('list').innerHTML = stores.map(s => \`
    <div class="row">
      <span class="badge \${s.status}">\${LABEL[s.status] ?? s.status}</span>
      <span class="name">
        <a href="\${s.url}" target="_blank" rel="noopener">\${s.name}</a>
        <span class="src">\${srcLabel(s)}</span>
      </span>
      <span class="price">\${s.price ?? '&mdash;'}</span>
      <span class="when">\${ago(s.checkedAt, d.now)}</span>
    </div>\`).join('');
}

load(); health();
setInterval(load, 15000);
setInterval(health, 30000);
</script>
</body>
</html>`;
}
