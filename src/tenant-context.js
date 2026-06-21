import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_ROOT = path.resolve('data');
const DEFAULT_TENANT_ID = 'daltec-local';

export function tenantIdFrom(value) {
  return sanitizeTenantId(value || DEFAULT_TENANT_ID);
}

export function tenantContext(input = {}) {
  const tenantId = tenantIdFrom(input.tenantId || input.id);
  const baseDir = path.join(DATA_ROOT, 'tenants', tenantId);
  return {
    tenantId,
    baseDir,
    settingsPath: path.join(baseDir, 'settings.json'),
    tenantPath: path.join(baseDir, 'tenant.json'),
    offersPath: path.join(baseDir, 'offers.jsonl'),
    inventoryPath: path.join(baseDir, 'lager.csv'),
    mailConnectionsPath: path.join(baseDir, 'mail-connections.json')
  };
}

export async function listTenantContexts() {
  let entries = [];
  try {
    entries = await fs.readdir(path.join(DATA_ROOT, 'tenants'), { withFileTypes: true });
  } catch {
    return [tenantContext({ tenantId: DEFAULT_TENANT_ID })];
  }

  const tenantIds = new Set([DEFAULT_TENANT_ID]);
  for (const entry of entries) {
    if (entry.isDirectory()) tenantIds.add(sanitizeTenantId(entry.name));
  }
  return [...tenantIds].map((tenantId) => tenantContext({ tenantId }));
}

export function sanitizeTenantId(value) {
  const normalized = String(value || DEFAULT_TENANT_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_TENANT_ID;
}

export { DEFAULT_TENANT_ID };
