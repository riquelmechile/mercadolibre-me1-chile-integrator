import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  CarrierContractHttpError,
  MercadoEnviosCarrierOAuth,
  type MercadoEnviosCarrierAudience,
} from './meli-carrier-auth.js';
import {
  MercadoEnviosCarrierContractState,
  type MercadoEnviosAgency,
  type MercadoEnviosCoverageCity,
  type MercadoEnviosTrackingRecord,
} from './meli-carrier-contract.js';

export interface MercadoEnviosCarrierHarnessOptions {
  host: string;
  clientId: string;
  clientSecret: string;
  carrierCode: string;
  coverage: readonly MercadoEnviosCoverageCity[];
  agencies: readonly MercadoEnviosAgency[];
  tracking: readonly MercadoEnviosTrackingRecord[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function authorizationHeader(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' ? value : undefined;
}

function objectBody(request: FastifyRequest): Record<string, unknown> | undefined {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function authorize(
  oauth: MercadoEnviosCarrierOAuth,
  request: FastifyRequest,
  audience: MercadoEnviosCarrierAudience,
): void {
  oauth.authorize(authorizationHeader(request), audience);
}

function authFailureBody(request: FastifyRequest, error: CarrierContractHttpError): Record<string, unknown> {
  const match = request.url.match(/^\/shipments\/([^/?]+)\/authorization/);
  if (error.statusCode === 400 && match) {
    return { id: match[1], status: 'FAILED', status_message: error.message };
  }
  return { status: error.statusCode, error: error.code, message: error.message, cause: [] };
}

export function buildMercadoEnviosCarrierHarness(options: MercadoEnviosCarrierHarnessOptions): FastifyInstance {
  if (!LOOPBACK.has(options.host)) throw new Error('Mercado Envíos Carrier CIT harness is loopback-only');

  const oauth = new MercadoEnviosCarrierOAuth(options.clientId, options.clientSecret);
  const state = new MercadoEnviosCarrierContractState(
    options.carrierCode,
    options.coverage,
    options.agencies,
    options.tracking,
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 512 * 1024,
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CarrierContractHttpError) {
      return reply.status(error.statusCode).send(authFailureBody(request, error));
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      const badRequest = new CarrierContractHttpError(400, 'bad_request', 'Invalid request body');
      return reply.status(400).send(authFailureBody(request, badRequest));
    }
    request.log.error(error);
    return reply.status(500).send({ status: 500, error: 'server_error', message: 'Carrier CIT harness error', cause: [] });
  });

  app.post('/oauth/token', async (request, reply) => {
    const result = oauth.issue(authorizationHeader(request), objectBody(request));
    return reply.status(200).send(result);
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const body = objectBody(request);
    const result = oauth.revoke(authorizationHeader(request), body?.token);
    return reply.status(200).send(result);
  });

  app.post('/coverage', async (request, reply) => {
    authorize(oauth, request, 'coverage');
    return reply.status(200).send(state.publishCoverage(request.body));
  });

  app.post('/agencies', async (request, reply) => {
    authorize(oauth, request, 'agencies');
    return reply.status(200).send(state.publishAgencies(request.body));
  });

  app.post<{ Params: { shipmentId: string } }>('/shipments/:shipmentId/authorization', async (request, reply) => {
    authorize(oauth, request, 'authorizations');
    return reply.status(200).send(state.authorizeShipment(request.params.shipmentId, request.body));
  });

  app.put<{ Params: { shipmentId: string } }>('/shipments/:shipmentId/authorization', async (request, reply) => {
    authorize(oauth, request, 'authorizations');
    return reply.status(200).send(state.cancelAuthorization(request.params.shipmentId, request.body));
  });

  app.put<{ Params: { shipmentId: string } }>('/shipments/:shipmentId/delivery-block', async (request, reply) => {
    authorize(oauth, request, 'authorizations');
    return reply.status(200).send(state.blockDelivery(request.params.shipmentId, request.body));
  });

  app.post('/tracking', async (request, reply) => {
    authorize(oauth, request, 'tracking-pull');
    return reply.status(200).send(state.pullTracking(request.body));
  });

  return app;
}
