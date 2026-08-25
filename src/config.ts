import { IntegrationGatedError } from './domain.js';
import type { SecretProvider } from './ports.js';

export interface AppConfig {
  host: string;
  port: number;
  sqlitePath: string;
  logLevel: string;
  me1Certified: boolean;
  enableDevRoutes: boolean;
  meliApiBaseUrl: string;
  apiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.APP_HOST ?? '127.0.0.1',
    port: Number(env.APP_PORT ?? 8787),
    sqlitePath: env.SQLITE_PATH ?? './data/me1-integrator.sqlite',
    logLevel: env.LOG_LEVEL ?? 'info',
    me1Certified: String(env.ME1_CERTIFIED ?? 'false').toLowerCase() === 'true',
    enableDevRoutes: String(env.ENABLE_DEV_ROUTES ?? 'false').toLowerCase() === 'true',
    meliApiBaseUrl: env.MELI_API_BASE_URL ?? 'https://api.mercadolibre.com',
    apiKey: env.APP_API_KEY || undefined,
  };
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string): Promise<string> {
    const key = `SECRET_${reference.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
    const value = this.env[key];
    if (!value) {
      throw new IntegrationGatedError('Credential reference is not available in the runtime secret provider', {
        credentialRef: reference,
        envKey: key,
      });
    }
    return value;
  }
}

const forbiddenConfigKeys = /(token|secret|password|api[_-]?key|access[_-]?key|credential)$/i;

export function assertNoInlineSecrets(value: Record<string, unknown>): void {
  const stack: Array<[string, unknown]> = Object.entries(value);
  while (stack.length > 0) {
    const [key, current] = stack.pop()!;
    if (forbiddenConfigKeys.test(key)) {
      throw new Error(`Inline secret-like field is not allowed in config: ${key}`);
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const entry of Object.entries(current as Record<string, unknown>)) stack.push(entry);
    }
  }
}
