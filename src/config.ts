import { IntegrationGatedError, type CarrierProvider } from './domain.js';
import {
  validateControlledShipmentApproval,
  validateControlledShipmentPreview,
  type ControlledShipmentApproval,
  type ControlledShipmentPreview,
} from './controlled-shipment.js';
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
  controlledShipmentPreview?: ControlledShipmentPreview;
  controlledShipmentApproval?: ControlledShipmentApproval;
}

const carrierProviders = new Set<CarrierProvider>(['mock', 'starken', 'blueexpress', 'chilexpress']);

function allOrNone(raw: Record<string, string | undefined>, label: string): boolean {
  const values = Object.values(raw);
  if (values.every((value) => value == null || value === '')) return false;
  if (values.some((value) => value == null || value === '')) throw new Error(`${label} environment is incomplete`);
  return true;
}

function providerFrom(value: string, label: string): CarrierProvider {
  if (!carrierProviders.has(value as CarrierProvider)) throw new Error(`${label} provider is invalid`);
  return value as CarrierProvider;
}

function controlledShipmentPreviewFromEnv(env: NodeJS.ProcessEnv): ControlledShipmentPreview | undefined {
  const raw = {
    previewId: env.CONTROLLED_SHIPMENT_PREVIEW_ID,
    tenantId: env.CONTROLLED_SHIPMENT_PREVIEW_TENANT_ID,
    provider: env.CONTROLLED_SHIPMENT_PREVIEW_PROVIDER,
    secretSha256: env.CONTROLLED_SHIPMENT_PREVIEW_SECRET_SHA256,
    issuedAt: env.CONTROLLED_SHIPMENT_PREVIEW_ISSUED_AT,
    expiresAt: env.CONTROLLED_SHIPMENT_PREVIEW_EXPIRES_AT,
  };
  if (!allOrNone(raw, 'controlled shipment preview')) return undefined;
  return validateControlledShipmentPreview({
    previewId: raw.previewId!,
    tenantId: raw.tenantId!,
    provider: providerFrom(raw.provider!, 'controlled shipment preview'),
    secretSha256: raw.secretSha256!,
    issuedAt: raw.issuedAt!,
    expiresAt: raw.expiresAt!,
  });
}

function controlledShipmentApprovalFromEnv(env: NodeJS.ProcessEnv): ControlledShipmentApproval | undefined {
  const raw = {
    approvalId: env.CONTROLLED_SHIPMENT_APPROVAL_ID,
    tenantId: env.CONTROLLED_SHIPMENT_TENANT_ID,
    provider: env.CONTROLLED_SHIPMENT_PROVIDER,
    payloadSha256: env.CONTROLLED_SHIPMENT_PAYLOAD_SHA256,
    secretSha256: env.CONTROLLED_SHIPMENT_SECRET_SHA256,
    issuedAt: env.CONTROLLED_SHIPMENT_ISSUED_AT,
    expiresAt: env.CONTROLLED_SHIPMENT_EXPIRES_AT,
  };
  if (!allOrNone(raw, 'controlled shipment approval')) return undefined;
  return validateControlledShipmentApproval({
    approvalId: raw.approvalId!,
    tenantId: raw.tenantId!,
    provider: providerFrom(raw.provider!, 'controlled shipment approval'),
    payloadSha256: raw.payloadSha256!,
    secretSha256: raw.secretSha256!,
    issuedAt: raw.issuedAt!,
    expiresAt: raw.expiresAt!,
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const controlledShipmentPreview = controlledShipmentPreviewFromEnv(env);
  const controlledShipmentApproval = controlledShipmentApprovalFromEnv(env);
  return {
    host: env.APP_HOST ?? '127.0.0.1',
    port: Number(env.APP_PORT ?? 8787),
    sqlitePath: env.SQLITE_PATH ?? './data/me1-integrator.sqlite',
    logLevel: env.LOG_LEVEL ?? 'info',
    me1Certified: String(env.ME1_CERTIFIED ?? 'false').toLowerCase() === 'true',
    enableDevRoutes: String(env.ENABLE_DEV_ROUTES ?? 'false').toLowerCase() === 'true',
    meliApiBaseUrl: env.MELI_API_BASE_URL ?? 'https://api.mercadolibre.com',
    apiKey: env.APP_API_KEY || undefined,
    ...(controlledShipmentPreview ? { controlledShipmentPreview } : {}),
    ...(controlledShipmentApproval ? { controlledShipmentApproval } : {}),
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
