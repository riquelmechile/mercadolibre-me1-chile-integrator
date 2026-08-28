import { randomBytes, timingSafeEqual } from 'node:crypto';

export const MERCADO_ENVIOS_CARRIER_AUDIENCES = [
  'authorizations',
  'tracking-pull',
  'agencies',
  'booking',
  'logistic-feed',
  'handling-unit',
  'rtt',
  'fiscal-info',
  'revoke',
  'coverage',
] as const;

export type MercadoEnviosCarrierAudience = (typeof MERCADO_ENVIOS_CARRIER_AUDIENCES)[number];

export class CarrierContractHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CarrierContractHttpError';
  }
}

interface TokenRecord {
  audience: MercadoEnviosCarrierAudience;
  expiresAtMs: number;
  revoked: boolean;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerValue(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) throw new CarrierContractHttpError(401, 'unauthorized', 'Bearer token is required');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new CarrierContractHttpError(401, 'unauthorized', 'Bearer token is required');
  return token;
}

function basicCredentials(header: string | undefined): { clientId: string; clientSecret: string } {
  if (!header?.startsWith('Basic ')) throw new CarrierContractHttpError(401, 'unauthorized', 'Basic credentials are required');
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
  } catch {
    throw new CarrierContractHttpError(401, 'unauthorized', 'Basic credentials are invalid');
  }
  const separator = decoded.indexOf(':');
  if (separator <= 0) throw new CarrierContractHttpError(401, 'unauthorized', 'Basic credentials are invalid');
  return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
}

export class MercadoEnviosCarrierOAuth {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly audienceSet = new Set<string>(MERCADO_ENVIOS_CARRIER_AUDIENCES);

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!clientId || !clientSecret) throw new Error('Carrier OAuth fixture credentials are required');
  }

  issue(
    authorizationHeader: string | undefined,
    body: Record<string, unknown> | undefined,
  ): { access_token: string; token_type: 'Bearer'; expires_in: 21600 } {
    const credentials = basicCredentials(authorizationHeader);
    if (!safeEqual(credentials.clientId, this.clientId) || !safeEqual(credentials.clientSecret, this.clientSecret)) {
      throw new CarrierContractHttpError(401, 'unauthorized', 'Basic credentials are invalid');
    }
    if (!body || typeof body !== 'object') throw new CarrierContractHttpError(400, 'bad_request', 'JSON body is required');
    if (body.grant_type !== 'client_credentials') throw new CarrierContractHttpError(400, 'bad_request', 'grant_type must be client_credentials');
    if (typeof body.audience !== 'string' || !this.audienceSet.has(body.audience)) {
      throw new CarrierContractHttpError(400, 'bad_request', 'audience is missing or unsupported');
    }
    const accessToken = randomBytes(32).toString('base64url');
    this.tokens.set(accessToken, {
      audience: body.audience as MercadoEnviosCarrierAudience,
      expiresAtMs: this.now() + 21_600_000,
      revoked: false,
    });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: 21600 };
  }

  authorize(authorizationHeader: string | undefined, audience: MercadoEnviosCarrierAudience): string {
    const token = bearerValue(authorizationHeader);
    const record = this.tokens.get(token);
    if (!record || record.revoked || record.expiresAtMs <= this.now() || record.audience !== audience) {
      throw new CarrierContractHttpError(401, 'unauthorized', 'Bearer token is invalid for this audience');
    }
    return token;
  }

  revoke(authorizationHeader: string | undefined, targetToken: unknown): { status: 'OK' } {
    const revoker = this.authorize(authorizationHeader, 'revoke');
    if (typeof targetToken !== 'string' || !targetToken) {
      throw new CarrierContractHttpError(400, 'bad_request', 'token is required');
    }
    if (safeEqual(revoker, targetToken)) {
      throw new CarrierContractHttpError(400, 'bad_request', 'revocation token must differ from target token');
    }
    const record = this.tokens.get(targetToken);
    if (!record) throw new CarrierContractHttpError(400, 'bad_request', 'target token is unknown');
    record.revoked = true;
    return { status: 'OK' };
  }
}
