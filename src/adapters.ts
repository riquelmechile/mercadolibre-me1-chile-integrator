import { createHash } from 'node:crypto';
import {
  IntegrationGatedError,
  UnsupportedCapabilityError,
  type CarrierCapability,
  type CarrierConnection,
  type CarrierProvider,
  type ProviderShipmentReconciliation,
  type ProviderShipmentResult,
  type QuoteInput,
  type QuoteResult,
  type SellerConnection,
  type ShipmentCreateInput,
} from './domain.js';
import type { CourierAdapter, MarketplaceAdapter, SecretProvider } from './ports.js';
import { ContractDrivenStarkenAdapter } from './starken-contract.js';
import { OfficialStarkenPluginAdapter, isOfficialStarkenProtocol } from './starken-official.js';

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

export class StarkenAdapter implements CourierAdapter {
  readonly provider = 'starken' as const;
  private readonly contractDriven: ContractDrivenStarkenAdapter;
  private readonly official: OfficialStarkenPluginAdapter;

  constructor(secrets?: SecretProvider) {
    const secretProvider = secrets ?? {
      async resolve(reference: string): Promise<string> {
        throw new IntegrationGatedError('Starken credential provider is not configured in this runtime', { credentialRef: reference });
      },
    };
    this.contractDriven = new ContractDrivenStarkenAdapter(secretProvider);
    this.official = new OfficialStarkenPluginAdapter(secretProvider);
  }

  capabilities(connection: CarrierConnection): ReadonlySet<CarrierCapability> {
    return isOfficialStarkenProtocol(connection)
      ? this.official.capabilities(connection)
      : this.contractDriven.capabilities(connection);
  }

  quote(input: QuoteInput, connection: CarrierConnection): Promise<QuoteResult> {
    return isOfficialStarkenProtocol(connection)
      ? this.official.quote(input, connection)
      : this.contractDriven.quote(input, connection);
  }

  createShipment(input: ShipmentCreateInput, connection: CarrierConnection): Promise<ProviderShipmentResult> {
    return isOfficialStarkenProtocol(connection)
      ? this.official.createShipment(input, connection)
      : this.contractDriven.createShipment(input, connection);
  }

  reconcileShipment(shipment: import('./domain.js').Shipment, connection: CarrierConnection): Promise<ProviderShipmentReconciliation> {
    return isOfficialStarkenProtocol(connection)
      ? this.official.reconcileShipment(shipment, connection)
      : Promise.resolve({ ...(shipment.trackingNumber ? { trackingNumber: shipment.trackingNumber } : {}) });
  }

  tracking(shipment: import('./domain.js').Shipment, connection: CarrierConnection) {
    return isOfficialStarkenProtocol(connection)
      ? this.official.tracking(shipment, connection)
      : this.contractDriven.tracking(shipment, connection);
  }
}

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
    return this.authorizedGet(connection, `/orders/${encodeURIComponent(orderId)}`, 'Mercado Libre order request failed');
  }

  async fetchSellerShippingPreferences(connection: SellerConnection): Promise<Record<string, unknown>> {
    return this.authorizedGet(
      connection,
      `/users/${encodeURIComponent(connection.sellerId)}/shipping_preferences`,
      'Mercado Libre seller shipping preferences request failed',
    );
  }

  async fetchCategoryShippingPreferences(
    connection: SellerConnection,
    categoryId: string,
  ): Promise<Record<string, unknown>> {
    return this.authorizedGet(
      connection,
      `/categories/${encodeURIComponent(categoryId)}/shipping_preferences`,
      'Mercado Libre category shipping preferences request failed',
    );
  }

  async fetchItem(connection: SellerConnection, itemId: string): Promise<Record<string, unknown>> {
    return this.authorizedGet(
      connection,
      `/items/${encodeURIComponent(itemId)}`,
      'Mercado Libre item request failed',
    );
  }

  async fetchItemShippingModes(
    connection: SellerConnection,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.authorizedJsonReadRequest(
      connection,
      `/users/${encodeURIComponent(connection.sellerId)}/shipping_modes`,
      payload,
      'Mercado Libre item shipping-modes probe failed',
      { 'x-multichannel': 'true', 'X-Format-New': 'true' },
    );
  }

  async fetchItemShippingOptions(
    connection: SellerConnection,
    itemId: string,
    zipCode: string,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ zip_code: zipCode }).toString();
    return this.authorizedGet(
      connection,
      `/items/${encodeURIComponent(itemId)}/shipping_options?${query}`,
      'Mercado Libre item shipping options request failed',
    );
  }

  async publishCustomTracking(
    connection: SellerConnection,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (connection.config.customShippingWritesEnabled !== true) {
      throw new IntegrationGatedError('Mercado Libre Custom Shipping writes are disabled for this seller connection');
    }
    await this.authorizedJsonRequest(
      connection,
      `/shipments/${encodeURIComponent(shipmentId)}`,
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

  private async authorizedGet(
    connection: SellerConnection,
    path: string,
    failureMessage: string,
  ): Promise<Record<string, unknown>> {
    const token = await this.secrets.resolve(connection.credentialRef);
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new IntegrationGatedError(failureMessage, { status: response.status });
    }
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new IntegrationGatedError('Mercado Libre response must be a JSON object');
    }
    return body as Record<string, unknown>;
  }

  private async authorizedJsonReadRequest(
    connection: SellerConnection,
    path: string,
    payload: Record<string, unknown>,
    failureMessage: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const token = await this.secrets.resolve(connection.credentialRef);
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new IntegrationGatedError(failureMessage, { status: response.status });
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new IntegrationGatedError('Mercado Libre response must be a JSON object');
    }
    return body as Record<string, unknown>;
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
