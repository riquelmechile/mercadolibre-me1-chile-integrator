import {
  AppError,
  NotFoundError,
  type AutomaticOrderItem,
  type AutomaticShipmentRequest,
  type CarrierProvider,
  type PackageSpec,
  type PackagingProfile,
  type PackagingResolution,
  type PackagingResolutionItem,
  type QuoteResult,
  type Shipment,
} from './domain.js';
import type { Store } from './ports.js';
import { LogisticsService } from './services.js';

function norm(value: string | undefined | null): string {
  return (value ?? '').trim().toLocaleLowerCase('es-CL');
}

function roundMeasure(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function applyQuantity(profile: PackagingProfile, quantity: number): PackageSpec {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError('invalid_quantity', 'Item quantity must be a positive integer', 400, { quantity });
  }
  if (quantity > profile.maxQuantity) {
    throw new AppError('packaging_quantity_exceeded', 'Configured packaging profile does not cover this quantity', 422, {
      profileId: profile.id,
      maxQuantity: profile.maxQuantity,
      quantity,
    });
  }
  const base = profile.package;
  switch (profile.packingMode) {
    case 'fixed':
      return { ...base };
    case 'scale_weight_only':
      return { ...base, weightKg: roundMeasure(base.weightKg * quantity) };
    case 'stack_height':
      return { ...base, weightKg: roundMeasure(base.weightKg * quantity), heightCm: base.heightCm * quantity };
    case 'stack_length':
      return { ...base, weightKg: roundMeasure(base.weightKg * quantity), lengthCm: base.lengthCm * quantity };
    case 'stack_width':
      return { ...base, weightKg: roundMeasure(base.weightKg * quantity), widthCm: base.widthCm * quantity };
    case 'threshold_growth': {
      const rule = profile.quantityRule;
      if (!rule) {
        throw new AppError('invalid_packaging_rule', 'threshold_growth requires quantityRule', 500, { profileId: profile.id });
      }
      if (quantity < rule.threshold) {
        return { ...base, weightKg: roundMeasure(base.weightKg * quantity) };
      }
      const additional = quantity - rule.threshold;
      return {
        weightKg: roundMeasure(base.weightKg * quantity),
        lengthCm: rule.fixedLengthCm,
        widthCm: roundMeasure(rule.baseWidthCm + rule.widthIncrementCm * additional),
        heightCm: roundMeasure(rule.baseHeightCm + rule.heightIncrementCm * additional),
      };
    }
  }
}

export class PackagingResolver {
  constructor(private readonly store: Store) {}

  resolve(tenantId: string, items: AutomaticOrderItem[]): PackagingResolution {
    if (!this.store.getTenant(tenantId)) throw new NotFoundError('Tenant not found', { tenantId });
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('invalid_items', 'At least one order item is required', 400);
    }
    const profiles = this.store.listPackagingProfiles(tenantId).filter((p) => p.active);
    const resolutions: PackagingResolutionItem[] = items.map((item) => {
      const profile = this.resolveProfile(profiles, item);
      if (profile.metadata.separatePackage === true && (items.length > 1 || item.quantity > 1)) {
        throw new AppError('multi_package_required', 'Order requires multiple packages; MVP automatic consolidation is intentionally blocked', 422, {
          sku: item.sku,
          profileId: profile.id,
        });
      }
      return {
        sku: item.sku,
        family: item.family ?? null,
        quantity: item.quantity,
        profileId: profile.id,
        profileName: profile.name,
        package: applyQuantity(profile, item.quantity),
      };
    });

    const combined: PackageSpec = {
      weightKg: resolutions.reduce((sum, item) => sum + item.package.weightKg, 0),
      lengthCm: Math.max(...resolutions.map((item) => item.package.lengthCm)),
      widthCm: Math.max(...resolutions.map((item) => item.package.widthCm)),
      heightCm: resolutions.reduce((sum, item) => sum + item.package.heightCm, 0),
    };
    return {
      package: combined,
      items: resolutions,
      profileIds: [...new Set(resolutions.map((item) => item.profileId))],
    };
  }

  private resolveProfile(profiles: PackagingProfile[], item: AutomaticOrderItem): PackagingProfile {
    const sku = norm(item.sku);
    const family = norm(item.family);
    const ranked = profiles
      .map((profile) => {
        let rank = -1;
        if (profile.matchType === 'sku' && norm(profile.matchValue) === sku) rank = 3;
        else if (profile.matchType === 'family' && family && norm(profile.matchValue) === family) rank = 2;
        else if (profile.matchType === 'default') rank = 1;
        return { profile, rank };
      })
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank || b.profile.priority - a.profile.priority || a.profile.createdAt.localeCompare(b.profile.createdAt));
    const match = ranked[0]?.profile;
    if (!match) {
      throw new NotFoundError('No packaging profile matches order item', { sku: item.sku, family: item.family ?? null });
    }
    return match;
  }
}

export interface AutomaticShipmentResult {
  shipment: Shipment;
  quote: QuoteResult;
  packaging: PackagingResolution;
}

export class AutomaticShippingService {
  constructor(
    private readonly store: Store,
    private readonly logistics: LogisticsService,
    private readonly packaging: PackagingResolver,
  ) {}

  async create(request: AutomaticShipmentRequest, actor = 'automatic', correlationId?: string): Promise<AutomaticShipmentResult> {
    const seller = this.store.getSellerConnection(request.tenantId, request.sellerId);
    if (!seller || !seller.enabled) throw new NotFoundError('Enabled seller connection not found', { sellerId: request.sellerId });

    // Packaging is resolved before any quote/provider call. Missing or unsafe dimensions fail closed here.
    const packaging = this.packaging.resolve(request.tenantId, request.items);
    const providers = request.preferredProvider
      ? [request.preferredProvider]
      : this.store.listCarrierConnections(request.tenantId).filter((c) => c.enabled).map((c) => c.provider);
    if (providers.length === 0) throw new NotFoundError('No enabled carrier connections available');

    const quotes: QuoteResult[] = [];
    const failures: Array<{ provider: CarrierProvider; reason: string }> = [];
    for (const provider of providers) {
      try {
        quotes.push(await this.logistics.quote({
          tenantId: request.tenantId,
          provider,
          origin: request.origin,
          destination: request.destination,
          package: packaging.package,
          allowLive: false,
          ...(request.deliveryPreference ? { deliveryPreference: request.deliveryPreference } : {}),
          ...(request.paymentMode ? { paymentMode: request.paymentMode } : {}),
          ...(request.declaredValueClp != null ? { declaredValueClp: request.declaredValueClp } : {}),
        }));
      } catch (error) {
        failures.push({ provider, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    quotes.sort((a, b) => a.amount - b.amount || a.estimatedBusinessDays - b.estimatedBusinessDays || a.provider.localeCompare(b.provider));
    const quote = quotes[0];
    if (!quote) {
      throw new NotFoundError('No eligible carrier quote for resolved package', { failures, package: packaging.package });
    }
    const requestedDeliveryMode = request.deliveryPreference === 'home' || request.deliveryPreference === 'agency'
      ? request.deliveryPreference
      : undefined;
    const selectedDeliveryMode = quote.deliveryMode ?? requestedDeliveryMode;

    const automaticMetadata = {
      automaticShipping: {
        sellerId: request.sellerId,
        packagingProfileIds: packaging.profileIds,
        packagingItems: packaging.items,
        resolvedPackage: packaging.package,
        quote,
        ...(request.deliveryPreference ? { deliveryPreference: request.deliveryPreference } : {}),
        ...(request.paymentMode ? { paymentMode: request.paymentMode } : {}),
        ...(request.declaredValueClp != null ? { declaredValueClp: request.declaredValueClp } : {}),
      },
    };
    const shipment = await this.logistics.createShipment({
      tenantId: request.tenantId,
      provider: quote.provider,
      externalOrderId: request.externalOrderId,
      ...(request.marketplaceShipmentId ? { marketplaceShipmentId: request.marketplaceShipmentId } : {}),
      origin: request.origin,
      destination: request.destination,
      package: packaging.package,
      serviceCode: quote.serviceCode,
      ...(selectedDeliveryMode ? { deliveryMode: selectedDeliveryMode } : {}),
      ...(request.paymentMode ? { paymentMode: request.paymentMode } : {}),
      ...(request.declaredValueClp != null ? { declaredValueClp: request.declaredValueClp } : {}),
      idempotencyKey: `automatic:${request.idempotencyKey}`,
      metadata: automaticMetadata,
    }, actor, correlationId);

    const storedAuto = shipment.metadata.automaticShipping as { quote?: QuoteResult; resolvedPackage?: PackageSpec; packagingProfileIds?: string[]; packagingItems?: PackagingResolutionItem[] } | undefined;
    if (storedAuto?.quote && storedAuto.resolvedPackage && storedAuto.packagingItems) {
      return {
        shipment,
        quote: storedAuto.quote,
        packaging: {
          package: storedAuto.resolvedPackage,
          profileIds: storedAuto.packagingProfileIds ?? packaging.profileIds,
          items: storedAuto.packagingItems,
        },
      };
    }
    return { shipment, quote, packaging };
  }
}
