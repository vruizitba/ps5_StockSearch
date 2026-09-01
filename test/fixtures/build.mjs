// Convierte las capturas .html en modulos .ts.
//
// El pool de vitest para Workers no soporta el import `?raw` de Vite, asi que
// el HTML se empaqueta como string. Para refrescar las capturas:
//
//   curl -sL -A "Mozilla/5.0" https://www.hotstock.io/us/p/playstation-5-pro-console-2tb \
//     -o test/fixtures/hotstock.html
//   curl -sL -A "Mozilla/5.0" https://www.nowinstock.net/videogaming/consoles/sonyps5/ \
//     -o test/fixtures/nowinstock.html
//   node test/fixtures/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

for (const name of ['hotstock', 'nowinstock']) {
  const html = readFileSync(new URL(`./${name}.html`, import.meta.url), 'utf8');
  writeFileSync(
    new URL(`./${name}.ts`, import.meta.url),
    `// Generado por build.mjs desde ${name}.html. No editar a mano.\n` +
      `export default ${JSON.stringify(html)};\n`,
  );
  console.log(name, html.length, 'bytes');
}
