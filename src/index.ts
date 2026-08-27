import { fileURLToPath } from 'node:url';
import {
  AdapterRegistry,
  BlueExpressAdapter,
  ChilexpressAdapter,
  MockCourierAdapter,
  MercadoLibreAdapter,
  StarkenAdapter,
} from './adapters.js';
import { EnvSecretProvider, loadConfig } from './config.js';
import { buildServer } from './server.js';
import { SqliteStore } from './store.js';

export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const store = new SqliteStore(config.sqlitePath);
  const secrets = new EnvSecretProvider(env);
  const marketplace = new MercadoLibreAdapter(secrets, config.meliApiBaseUrl, config.me1Certified);
  const adapters = new AdapterRegistry([
    new MockCourierAdapter(),
    new StarkenAdapter(secrets),
    new BlueExpressAdapter(),
    new ChilexpressAdapter(),
  ]);
  const app = buildServer({ store, adapters, config, secrets, marketplace });
  return { app, store, adapters, marketplace, config };
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  const runtime = createRuntime();
  runtime.app
    .listen({ host: runtime.config.host, port: runtime.config.port })
    .catch((error) => {
      runtime.app.log.error(error);
      process.exitCode = 1;
    });
}
