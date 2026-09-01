import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// Las migraciones se leen del mismo directorio que usa produccion: si un test
// pasa contra un esquema que no es el real, no prueba nada.
const migrations = await readD1Migrations('./migrations');

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        // Un solo worker: el cache a nivel modulo de hotstock/nowinstock es
        // estado compartido y los tests lo resetean a proposito.
        singleWorker: true,
        // El aislamiento por test de vitest-pool-workers no convive con el
        // trabajo en waitUntil que arma el reloj: la escritura sobrevive al
        // test y rompe el rollback. Los tests limpian la base a mano.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Solo para los tests: vitest-pool-workers lo exige. No se toca
          // wrangler.toml para no cambiar el runtime de produccion.
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            RESEND_API_KEY: 're_test_key',
            ADMIN_TOKEN: 'test-token',
            ALERT_EMAILS: 'uno@ejemplo.test',
            FROM_EMAIL: 'monitor@ejemplo.test',
            // Explicitamente vacios. Wrangler carga .dev.vars tambien en los
            // tests, asi que sin esto la suite dependeria de que credenciales
            // tenga cargadas cada maquina: agregar Telegram a .dev.vars hizo
            // que tests que solo mockean Resend salieran a la red de verdad.
            // Los que prueban varios canales arman su propio env.
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_CHAT_ID: '',
          },
        },
      },
    },
  },
});
