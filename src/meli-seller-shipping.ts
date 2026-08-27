import { IntegrationGatedError, NotFoundError, type SellerConnection } from './domain.js';
import type { MarketplaceAdapter, Store } from './ports.js';

export type SellerOwnedRecommendedPath = 'custom' | 'existing_me1' | 'none';

export interface SellerOwnedShippingCapabilities {
  sellerModes: string[];
  categoryModes: string[];
  itemMode: string | null;
  itemAvailableModes: string[] | null;
  itemLocalPickUp: boolean | null;
  itemFreeShipping: boolean | null;
  customEligible: boolean;
  me1AlreadyAvailable: boolean;
  dynamicFreightActivationRequiresCertifiedIntegrator: true;
  recommendedPath: SellerOwnedRecommendedPath;
  blockers: string[];
}

export interface AnalyzeSellerOwnedShippingInput {
  sellerPreferences: Record<string, unknown>;
  categoryPreferences: Record<string, unknown>;
  item: Record<string, unknown> | null;
  itemShippingModes?: Record<string, unknown> | null;
}

export interface CustomItemShippingPlanInput {
  itemId: string;
  costs: Array<{ description: string; cost: number }>;
}

export interface CustomShipmentUpdatePlanInput {
  shipmentId: string;
  status: 'shipped' | 'delivered' | 'cancelled';
  receiverId: string;
  trackingNumber?: string;
  speedHours?: number;
  comments?: string;
}

export interface MarketplaceDryRunPlan {
  dryRun: true;
  method: 'PUT' | 'POST';
  path: string;
  body: Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new IntegrationGatedError(`${label} response is malformed`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function categoryModes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new IntegrationGatedError('Category shipping preferences response is malformed');
  const modes: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IntegrationGatedError('Category shipping preferences response is malformed');
    }
    const mode = (entry as Record<string, unknown>).mode;
    if (typeof mode !== 'string' || !mode.trim()) {
      throw new IntegrationGatedError('Category shipping preferences response is malformed');
    }
    modes.push(mode.trim());
  }
  return [...new Set(modes)];
}

function itemMode(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const shipping = item.shipping;
  if (!shipping || typeof shipping !== 'object' || Array.isArray(shipping)) {
    throw new IntegrationGatedError('Item shipping response is malformed');
  }
  const mode = (shipping as Record<string, unknown>).mode;
  if (mode == null) return null;
  if (typeof mode !== 'string' || !mode.trim()) throw new IntegrationGatedError('Item shipping response is malformed');
  return mode.trim();
}

function itemShippingBoolean(item: Record<string, unknown> | null, key: string): boolean | null {
  if (!item) return null;
  const shipping = item.shipping;
  if (!shipping || typeof shipping !== 'object' || Array.isArray(shipping)) {
    throw new IntegrationGatedError('Item shipping response is malformed');
  }
  const value = (shipping as Record<string, unknown>)[key];
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new IntegrationGatedError('Item shipping response is malformed');
  return value;
}

function itemAvailableModes(value: Record<string, unknown> | null | undefined): string[] | null {
  if (value == null) return null;
  const channels = value.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new IntegrationGatedError('Item shipping-modes probe response is malformed');
  }
  const marketplace = (channels as Record<string, unknown>).marketplace;
  if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace)) {
    throw new IntegrationGatedError('Item shipping-modes probe response is malformed');
  }
  const available = (marketplace as Record<string, unknown>).available_modes;
  if (!Array.isArray(available)) throw new IntegrationGatedError('Item shipping-modes probe response is malformed');
  const modes: string[] = [];
  for (const entry of available) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IntegrationGatedError('Item shipping-modes probe response is malformed');
    }
    const mode = (entry as Record<string, unknown>).mode;
    if (typeof mode !== 'string' || !mode.trim()) throw new IntegrationGatedError('Item shipping-modes probe response is malformed');
    modes.push(mode.trim());
  }
  return [...new Set(modes)];
}

export function buildItemShippingModesProbe(item: Record<string, unknown>, sellerId: string): Record<string, unknown> {
  const id = item.id;
  const siteId = item.site_id;
  const categoryId = item.category_id;
  if (typeof id !== 'string' || !id.trim() || typeof siteId !== 'string' || !siteId.trim() || typeof categoryId !== 'string' || !categoryId.trim()) {
    throw new IntegrationGatedError('Item does not contain the identifiers required for shipping-mode prevalidation');
  }
  const shipping = item.shipping;
  const shippingRecord = shipping && typeof shipping === 'object' && !Array.isArray(shipping) ? shipping as Record<string, unknown> : {};
  const attributes = Array.isArray(item.attributes) ? item.attributes : [];
  return {
    site_id: siteId,
    item_id: id,
    seller_id: Number.isFinite(Number(sellerId)) ? Number(sellerId) : sellerId,
    title: typeof item.title === 'string' ? item.title : '',
    item_price: typeof item.price === 'number' ? item.price : null,
    item_currency: typeof item.currency_id === 'string' ? item.currency_id : null,
    category_id: categoryId,
    sale_terms: Array.isArray(item.sale_terms) ? item.sale_terms : [],
    listing_type_id: typeof item.listing_type_id === 'string' ? item.listing_type_id : null,
    buying_mode: typeof item.buying_mode === 'string' ? item.buying_mode : null,
    condition: typeof item.condition === 'string' ? item.condition : null,
    dimensions: shippingRecord.dimensions ?? null,
    local_pick_up: shippingRecord.local_pick_up === true,
    channels: [{ id: 'marketplace' }],
    attributes,
    new_format: true,
    verbose: false,
  };
}

export function analyzeSellerOwnedShipping(input: AnalyzeSellerOwnedShippingInput): SellerOwnedShippingCapabilities {
  const sellerModes = strings(input.sellerPreferences.modes, 'Seller shipping preferences');
  const modes = categoryModes(input.categoryPreferences.logistics);
  const currentItemMode = itemMode(input.item);
  const currentLocalPickUp = itemShippingBoolean(input.item, 'local_pick_up');
  const currentFreeShipping = itemShippingBoolean(input.item, 'free_shipping');
  const probedModes = itemAvailableModes(input.itemShippingModes);

  const sellerSupportsCustom = sellerModes.includes('custom');
  const categorySupportsCustom = modes.includes('custom');
  const itemAlreadyCustom = currentItemMode === 'custom';
  const probeSupportsCustom = probedModes?.includes('custom') ?? false;
  const customEligible = categorySupportsCustom && (itemAlreadyCustom || (probedModes ? probeSupportsCustom : sellerSupportsCustom));

  const sellerSupportsMe1 = sellerModes.includes('me1');
  const categorySupportsMe1 = modes.includes('me1');
  const itemAlreadyMe1 = currentItemMode === 'me1';
  const probeSupportsMe1 = probedModes?.includes('me1') ?? false;
  const me1AlreadyAvailable = itemAlreadyMe1 || (sellerSupportsMe1 && categorySupportsMe1 && (probedModes ? probeSupportsMe1 : true));

  const blockers: string[] = [];
  if (!categorySupportsCustom) blockers.push('Category evidence does not expose Custom Shipping.');
  if (!itemAlreadyCustom && categorySupportsCustom && probedModes && !probeSupportsCustom) {
    blockers.push('Mercado Libre item shipping-mode prevalidation does not expose Custom Shipping.');
  }
  if (!itemAlreadyCustom && categorySupportsCustom && !probedModes && !sellerSupportsCustom) {
    blockers.push('Seller shipping preferences do not expose Custom Shipping and no item-specific prevalidation was provided.');
  }

  return {
    sellerModes,
    categoryModes: modes,
    itemMode: currentItemMode,
    itemAvailableModes: probedModes,
    itemLocalPickUp: currentLocalPickUp,
    itemFreeShipping: currentFreeShipping,
    customEligible,
    me1AlreadyAvailable,
    dynamicFreightActivationRequiresCertifiedIntegrator: true,
    recommendedPath: me1AlreadyAvailable ? 'existing_me1' : customEligible ? 'custom' : 'none',
    blockers,
  };
}

function requiredId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new IntegrationGatedError(`${label} is required`);
  return trimmed;
}

export function buildCustomItemShippingPlan(
  capabilities: SellerOwnedShippingCapabilities,
  input: CustomItemShippingPlanInput,
): MarketplaceDryRunPlan {
  if (!capabilities.customEligible) {
    throw new IntegrationGatedError('Item is not eligible for seller-owned Custom Shipping based on observed Mercado Libre evidence');
  }
  const itemId = requiredId(input.itemId, 'itemId');
  if (!Array.isArray(input.costs) || input.costs.length === 0) {
    throw new IntegrationGatedError('At least one Custom Shipping cost is required');
  }
  const costs = input.costs.map((entry) => {
    const description = requiredId(entry.description, 'cost description');
    if (!Number.isFinite(entry.cost) || entry.cost < 0) throw new IntegrationGatedError('Custom Shipping cost must be a non-negative number');
    return { description, cost: String(Math.round(entry.cost)) };
  });
  return {
    dryRun: true,
    method: 'PUT',
    path: `/items/${encodeURIComponent(itemId)}`,
    body: {
      shipping: {
        mode: 'custom',
        local_pick_up: capabilities.itemLocalPickUp ?? false,
        free_shipping: false,
        methods: [],
        costs,
      },
    },
  };
}

export function buildCustomShipmentUpdatePlan(input: CustomShipmentUpdatePlanInput): MarketplaceDryRunPlan {
  const shipmentId = requiredId(input.shipmentId, 'shipmentId');
  const receiverId = requiredId(input.receiverId, 'receiverId');
  const body: Record<string, unknown> = { status: input.status, receiver_id: receiverId };
  let method: 'PUT' | 'POST' = 'PUT';

  if (input.status === 'shipped') {
    body.tracking_number = requiredId(input.trackingNumber ?? '', 'trackingNumber');
    if (input.speedHours != null) {
      if (!Number.isFinite(input.speedHours) || input.speedHours <= 0) throw new IntegrationGatedError('speedHours must be positive');
      body.speed = Math.round(input.speedHours);
    }
    if (input.comments?.trim()) body.comments = input.comments.trim();
  } else if (input.status === 'cancelled') {
    method = 'POST';
  }

  return { dryRun: true, method, path: `/shipments/${encodeURIComponent(shipmentId)}`, body };
}


export interface SellerOwnedShippingDiscoveryRequest {
  tenantId: string;
  sellerId: string;
  categoryId: string;
  itemId?: string;
}

export class MercadoLibreSellerShippingService {
  constructor(
    private readonly store: Store,
    private readonly marketplace: MarketplaceAdapter,
  ) {}

  private requireSeller(tenantId: string, sellerId: string): SellerConnection {
    const connection = this.store.getSellerConnection(tenantId, sellerId);
    if (!connection) throw new NotFoundError('Seller connection not found', { tenantId, sellerId });
    if (!connection.enabled) throw new IntegrationGatedError('Seller connection is disabled', { tenantId, sellerId });
    if (connection.marketplace !== 'mercadolibre') {
      throw new IntegrationGatedError('Seller-owned shipping planner only supports Mercado Libre');
    }
    return connection;
  }

  async discover(request: SellerOwnedShippingDiscoveryRequest): Promise<SellerOwnedShippingCapabilities> {
    const connection = this.requireSeller(request.tenantId, request.sellerId);
    const [sellerPreferences, categoryPreferences, item] = await Promise.all([
      this.marketplace.fetchSellerShippingPreferences(connection),
      this.marketplace.fetchCategoryShippingPreferences(connection, request.categoryId),
      request.itemId ? this.marketplace.fetchItem(connection, request.itemId) : Promise.resolve(null),
    ]);
    if (item) {
      const categoryId = item.category_id;
      if (typeof categoryId !== 'string' || categoryId !== request.categoryId) {
        throw new IntegrationGatedError('Item/category evidence mismatch', {
          requestedCategoryId: request.categoryId,
          observedCategoryId: typeof categoryId === 'string' ? categoryId : null,
        });
      }
    }
    const itemShippingModes = item
      ? await this.marketplace.fetchItemShippingModes(connection, buildItemShippingModesProbe(item, connection.sellerId))
      : null;
    return analyzeSellerOwnedShipping({ sellerPreferences, categoryPreferences, item, itemShippingModes });
  }

  async itemShippingOptions(tenantId: string, sellerId: string, itemId: string, zipCode: string): Promise<Record<string, unknown>> {
    const connection = this.requireSeller(tenantId, sellerId);
    return this.marketplace.fetchItemShippingOptions(connection, requiredId(itemId, 'itemId'), requiredId(zipCode, 'zipCode'));
  }

  async customItemPlan(
    request: SellerOwnedShippingDiscoveryRequest & CustomItemShippingPlanInput,
  ): Promise<MarketplaceDryRunPlan> {
    const capabilities = await this.discover(request);
    return buildCustomItemShippingPlan(capabilities, request);
  }

  customShipmentUpdatePlan(
    tenantId: string,
    sellerId: string,
    input: CustomShipmentUpdatePlanInput,
  ): MarketplaceDryRunPlan {
    this.requireSeller(tenantId, sellerId);
    return buildCustomShipmentUpdatePlan(input);
  }
}
