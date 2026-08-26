import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('controlled shipment approval environment is absent by default', () => {
  const config = loadConfig({});
  assert.equal(config.controlledShipmentPreview, undefined);
  assert.equal(config.controlledShipmentApproval, undefined);
});

test('partial controlled shipment approval environment fails closed at startup', () => {
  assert.throws(
    () => loadConfig({ CONTROLLED_SHIPMENT_APPROVAL_ID: 'approval-1' }),
    /controlled shipment approval environment is incomplete/i,
  );
});

test('complete controlled shipment approval environment parses only approval metadata and secret hash', () => {
  const secret = 'runtime-only-secret';
  const config = loadConfig({
    CONTROLLED_SHIPMENT_APPROVAL_ID: 'approval-1',
    CONTROLLED_SHIPMENT_TENANT_ID: 'tenant-1',
    CONTROLLED_SHIPMENT_PROVIDER: 'starken',
    CONTROLLED_SHIPMENT_PAYLOAD_SHA256: hash('payload'),
    CONTROLLED_SHIPMENT_SECRET_SHA256: hash(secret),
    CONTROLLED_SHIPMENT_ISSUED_AT: new Date(Date.now() - 1_000).toISOString(),
    CONTROLLED_SHIPMENT_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(config.controlledShipmentApproval?.provider, 'starken');
  assert.equal(config.controlledShipmentApproval?.secretSha256, hash(secret));
  assert.ok(!JSON.stringify(config).includes(secret));
});


test('partial controlled shipment preview environment fails closed at startup', () => {
  assert.throws(
    () => loadConfig({ CONTROLLED_SHIPMENT_PREVIEW_ID: 'preview-1' }),
    /controlled shipment preview environment is incomplete/i,
  );
});

test('complete controlled shipment preview environment is scope-only and contains no raw secret', () => {
  const secret = 'preview-runtime-only-secret';
  const config = loadConfig({
    CONTROLLED_SHIPMENT_PREVIEW_ID: 'preview-1',
    CONTROLLED_SHIPMENT_PREVIEW_TENANT_ID: 'tenant-1',
    CONTROLLED_SHIPMENT_PREVIEW_PROVIDER: 'starken',
    CONTROLLED_SHIPMENT_PREVIEW_SECRET_SHA256: hash(secret),
    CONTROLLED_SHIPMENT_PREVIEW_ISSUED_AT: new Date(Date.now() - 1_000).toISOString(),
    CONTROLLED_SHIPMENT_PREVIEW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(config.controlledShipmentPreview?.provider, 'starken');
  assert.equal(config.controlledShipmentPreview?.secretSha256, hash(secret));
  assert.equal(config.controlledShipmentApproval, undefined);
  assert.ok(!JSON.stringify(config).includes(secret));
});


test('controlled shipment observation environment fails closed when partial', () => {
  assert.throws(
    () => loadConfig({ CONTROLLED_SHIPMENT_OBSERVATION_ID: 'observation-1' }),
    /controlled shipment observation environment is incomplete/i,
  );
});

test('controlled shipment observation environment parses scoped metadata without raw secret', () => {
  const secret = 'runtime-observation-secret';
  const config = loadConfig({
    CONTROLLED_SHIPMENT_OBSERVATION_ID: 'observation-1',
    CONTROLLED_SHIPMENT_OBSERVATION_TENANT_ID: 'tenant-1',
    CONTROLLED_SHIPMENT_OBSERVATION_PROVIDER: 'starken',
    CONTROLLED_SHIPMENT_OBSERVATION_SHIPMENT_ID: 'shipment-1',
    CONTROLLED_SHIPMENT_OBSERVATION_SECRET_SHA256: hash(secret),
    CONTROLLED_SHIPMENT_OBSERVATION_ISSUED_AT: new Date(Date.now() - 1_000).toISOString(),
    CONTROLLED_SHIPMENT_OBSERVATION_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(config.controlledShipmentObservation?.provider, 'starken');
  assert.equal(config.controlledShipmentObservation?.shipmentId, 'shipment-1');
  assert.equal(config.controlledShipmentObservation?.secretSha256, hash(secret));
  assert.ok(!JSON.stringify(config).includes(secret));
});
