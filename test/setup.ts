import { applyD1Migrations, env } from 'cloudflare:test';

// Cada worker de test arranca con el esquema real aplicado.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
