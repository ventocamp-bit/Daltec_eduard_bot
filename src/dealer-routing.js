import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TENANT_ID, sanitizeTenantId, tenantContext } from './tenant-context.js';

const DATA_ROOT = path.resolve('data');

export async function resolveTenantContextForInbound(input = {}) {
  const tenantId = await resolveTenantIdForInbound(input);
  return tenantContext({ tenantId });
}

export async function resolveTenantIdForInbound(input = {}) {
  const explicit = normalizeDealerSlug(input.dealerSlug || input.dealer_slug);
  if (explicit) return explicit;

  const routed = await routeFromKnownTenants(input);
  if (routed) return routed;

  const domain = firstEmailDomain([input.fromEmail, input.from_email, input.from]);
  if (domain === 'daltec.at') return DEFAULT_TENANT_ID;

  return DEFAULT_TENANT_ID;
}

function normalizeDealerSlug(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'daltec') return DEFAULT_TENANT_ID;
  return sanitizeTenantId(raw);
}

async function routeFromKnownTenants(input) {
  const tenants = await loadTenantRoutingRecords();
  const allText = [
    input.toEmail,
    input.to_email,
    input.to,
    input.fromEmail,
    input.from_email,
    input.from,
    input.rawText,
    input.raw_text,
    input.text,
    stripHtml(input.rawHtml || input.raw_html || input.html)
  ].filter(Boolean).join('\n').toLowerCase();

  const plusAlias = findPlusAliasTenant(allText);
  if (plusAlias && tenants.some((tenant) => tenant.id === plusAlias)) return plusAlias;

  const toEmails = extractEmails([input.toEmail, input.to_email, input.to, allText].filter(Boolean).join('\n'));
  for (const tenant of tenants) {
    if (tenant.recipientEmails.some((email) => toEmails.includes(email))) return tenant.id;
  }

  const fromDomains = emailDomains([input.fromEmail, input.from_email, input.from].filter(Boolean).join('\n'));
  for (const tenant of tenants) {
    if (tenant.senderDomains.some((domain) => fromDomains.includes(domain))) return tenant.id;
  }

  return '';
}

async function loadTenantRoutingRecords() {
  let entries = [];
  try {
    entries = await fs.readdir(path.join(DATA_ROOT, 'tenants'), { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = sanitizeTenantId(entry.name);
    const tenantFile = path.join(DATA_ROOT, 'tenants', id, 'tenant.json');
    const settingsFile = path.join(DATA_ROOT, 'tenants', id, 'settings.json');
    const tenant = await readJson(tenantFile);
    const settings = await readJson(settingsFile);
    records.push({
      id,
      recipientEmails: normalizeList([
        tenant.routing?.recipientEmail,
        ...(tenant.routing?.recipientEmails || []),
        settings.onboarding?.forwardingAlias
      ]),
      senderDomains: normalizeList([
        tenant.routing?.senderDomain,
        ...(tenant.routing?.senderDomains || []),
        domainFromEmail(settings.mail?.to),
        domainFromEmail(settings.signature?.email)
      ])
    });
  }
  return records;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeList(values) {
  return values
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
}

function findPlusAliasTenant(text) {
  const match = String(text || '').match(/[a-z0-9._%+-]+\+([a-z0-9_-]+)@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? sanitizeTenantId(match[1]) : '';
}

function firstEmailDomain(values) {
  return emailDomains(values.filter(Boolean).join('\n'))[0] || '';
}

function emailDomains(value) {
  return extractEmails(value).map(domainFromEmail).filter(Boolean);
}

function domainFromEmail(value) {
  const match = String(value || '').toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/);
  return match ? match[1] : '';
}

function extractEmails(value) {
  return [...String(value || '').toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)]
    .map((match) => match[0]);
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}
