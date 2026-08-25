import { createHash } from 'node:crypto';
import {
  IntegrationGatedError,
  UnsupportedCapabilityError,
  type CarrierCapability,
  type CarrierConnection,
  type CarrierProvider,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type SellerConnection,
  type ShipmentCreateInput,
} from './domain.js';
import type { CourierAdapter, MarketplaceAdapter, SecretProvider } from './ports.js';
import { ContractDrivenStarkenAdapter } from './starken-contract.js';

export class MockCourierAdapter implements CourierAdapter {
  readonly provider = 'mock' as const;
  private readonly caps = new Set<CarrierCapability>(['quote', 'create_shipment', 'tracking', 'label']);

  capabilities(): ReadonlySet<CarrierCapability> {
    return this.caps;
  }

  async quote(input: QuoteInput): Promise<QuoteResult> {
    const volumetric = (input.package.lengthCm * input.package.widthCm * input.package.heightCm) / 4000;
    const chargeableWeightKg = Math.max(input.package.weightKg, volumetric);
    return {
      provider: this.provider,
      serviceCode: 'MOCK_STANDARD',
      serviceName: 'Mock Standard',
      currency: 'CLP',
      amount: Math.round(3990 + chargeableWeightKg * 450),
      estimatedBusinessDays: 2,
      chargeableWeightKg,
      snapshotVersion: null,
      source: 'live',
    };
  }

  async createShipment(input: ShipmentCreateInput): Promise<ProviderShipmentResult> {
    const digest = createHash('sha256').update(`${input.tenantId}:${input.idempotencyKey}`).digest('hex').slice(0, 16);
    return {
      providerShipmentRef: `mock-${digest}`,
      trackingNumber: `MOCK${digest.toUpperCase()}`,
      status: 'label_ready',
      labelUrl: `https://example.invalid/labels/${digest}.pdf`,
      metadata: { simulated: true },
    };
  }
}

abstract class ContractGatedCourierAdapter implements CourierAdapter {
  abstract readonly provider: Exclude<CarrierProvider, 'mock'>;

  capabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
    const configured = connection.config.capabilities;
    if (!Array.isArray(configured)) return new Set();
    return new Set(configured.filter((v): v is CarrierCapability => typeof v === 'string') as CarrierCapability[]);
  }

  async quote(_input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    if (!this.capabilities(connection).has('quote')) {
      throw new UnsupportedCapabilityError(this.provider, 'quote');
    }
    throw new IntegrationGatedError(
      `${this.provider} quote mapping is intentionally gated until the official account contract is loaded`,
      { provider: this.provider, expectedConfig: ['contractVersion', 'quoteMapping'] },
    );
  }

  async createShipment(
    _input: ShipmentCreateInput,
    connection: CarrierConnection,
  ): Promise<ProviderShipmentResult> {
    if (!this.capabilities(connection).has('create_shipment')) {
      throw new UnsupportedCapabilityError(this.provider, 'create_shipment');
    }
    throw new IntegrationGatedError(
      `${this.provider} shipment mapping is intentionally gated until the official account contract is loaded`,
      { provider: this.provider, expectedConfig: ['contractVersion', 'shipmentMapping'] },
    );
  }
}

export class StarkenAdapter extends ContractDrivenStarkenAdapter {}

export class BlueExpressAdapter extends ContractGatedCourierAdapter {
  readonly provider = 'blueexpress' as const;
}

export class ChilexpressAdapter extends ContractGatedCourierAdapter {
  readonly provider = 'chilexpress' as const;
}

export class AdapterRegistry {
  private readonly adapters = new Map<CarrierProvider, CourierAdapter>();

  constructor(adapters: CourierAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter);
  }

  get(provider: CarrierProvider): CourierAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new IntegrationGatedError('Courier adapter is not registered', { provider });
    return adapter;
  }

  providers(): CarrierProvider[] {
    return [...this.adapters.keys()];
  }
}

export class MercadoLibreAdapter implements MarketplaceAdapter {
  readonly provider = 'mercadolibre' as const;

  constructor(
    private readonly secrets: SecretProvider,
    private readonly apiBaseUrl: string,
    private readonly runtimeMe1Certified: boolean,
  ) {}

  async fetchOrder(connection: SellerConnection, orderId: string): Promise<Record<string, unknown>> {
    const token = await this.secrets.resolve(connection.credentialRef);
    const response = await fetch(`${this.apiBaseUrl}/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new IntegrationGatedError('Mercado Libre order request failed', { status: response.status });
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async publishCustomTracking(
    connection: SellerConnection,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const template = connection.config.customShipmentPathTemplate;
    if (typeof template !== 'string' || !template.includes('{shipmentId}')) {
      throw new IntegrationGatedError(
        'Custom shipment write is gated until the verified account contract/path template is configured',
      );
    }
    await this.authorizedJsonRequest(
      connection,
      template.replace('{shipmentId}', encodeURIComponent(shipmentId)),
      'PUT',
      payload,
    );
  }

  async publishMe1Tracking(
    connection: SellerConnection,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.runtimeMe1Certified || connection.config.me1Certified !== true) {
      throw new IntegrationGatedError('ME1 publication is disabled until certification is explicitly enabled');
    }
    await this.authorizedJsonRequest(
      connection,
      `/v2/shipments/${encodeURIComponent(shipmentId)}/seller_notifications`,
      'POST',
      payload,
    );
  }

  private async authorizedJsonRequest(
    connection: SellerConnection,
    path: string,
    method: 'POST' | 'PUT',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.secrets.resolve(connection.credentialRef);
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new IntegrationGatedError('Mercado Libre write request failed', { status: response.status });
    }
  }
}
