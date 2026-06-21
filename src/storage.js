import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tenantContext } from './tenant-context.js';
import * as postgresStorage from './postgres-storage.js';
import { buildLeadFingerprint } from './lead-fingerprint.js';

const DATA_DIR = path.resolve('data');
const TENANT_PATH = path.join(DATA_DIR, 'tenant.json');
const OFFERS_PATH = path.join(DATA_DIR, 'offers.jsonl');
const ACTIVE_RUN_STATUSES = new Set(['received', 'parsing', 'parsed', 'matching', 'pricing', 'drafting', 'completed', 'needs_review']);

function usePostgresStorage() {
  return Boolean(process.env.DATABASE_URL);
}

export async function loadTenant(context = {}) {
  if (usePostgresStorage()) return postgresStorage.loadTenant(context);
  const paths = getStoragePaths(context);
  await fs.mkdir(paths.baseDir, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(paths.tenantPath, 'utf8'));
  } catch {
    const tenant = await loadSeedTenant(paths);
    await saveTenant(tenant, paths);
    return tenant;
  }
}

export async function saveTenant(input, context = {}) {
  if (usePostgresStorage()) return postgresStorage.saveTenant(input, context);
  const paths = getStoragePaths(context);
  await fs.mkdir(paths.baseDir, { recursive: true });
  const tenant = {
    ...defaultTenant(paths.tenantId),
    ...input,
    id: paths.tenantId,
    onboarding: {
      ...defaultTenant(paths.tenantId).onboarding,
      ...(input?.onboarding || {})
    },
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(paths.tenantPath, `${JSON.stringify(tenant, null, 2)}\n`, 'utf8');
  return tenant;
}

export async function appendOfferRecord(workflowResult, source = {}, context = {}) {
  if (usePostgresStorage()) return postgresStorage.appendOfferRecord(workflowResult, source, context);
  const paths = getStoragePaths(context);
  await fs.mkdir(paths.baseDir, { recursive: true });
  const record = {
    id: crypto.randomUUID(),
    tenantId: paths.tenantId,
    createdAt: new Date().toISOString(),
    source: {
      messageId: source.messageId || null,
      subject: source.subject || null,
      mode: source.mode || 'workflow'
    },
    customer: {
      firstName: workflowResult.inquiry?.kunde_vorname || '',
      lastName: workflowResult.inquiry?.kunde_nachname || '',
      email: workflowResult.inquiry?.kunde_email || '',
      phone: workflowResult.inquiry?.kunde_telefon || '',
      address: workflowResult.inquiry?.kunde_adresse || ''
    },
    offer: {
      subject: workflowResult.offer?.betreff || '',
      customerEmail: workflowResult.offer?.email || '',
      totalGross: workflowResult.matched?.kalkulation_anfrage?.gesamt_angebot_brutto || 0,
      uvpGross: workflowResult.matched?.kalkulation_anfrage?.gesamt_uvp_brutto || 0,
      discountGross: workflowResult.matched?.kalkulation_anfrage?.gesamt_rabatt_brutto || 0,
      hasInventoryMatch: workflowResult.matched?.hat_match === true,
      topInventoryName: workflowResult.matched?.top_lager_name || null
    },
    status: 'draft_sent_internal'
  };

  await fs.appendFile(paths.offersPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function listOfferRecords(limit = 50, context = {}) {
  if (usePostgresStorage()) return postgresStorage.listOfferRecords(limit, context);
  const paths = getStoragePaths(context);
  try {
    const content = await fs.readFile(paths.offersPath, 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

export async function ingestInboundMessage(input, context = {}) {
  if (usePostgresStorage()) return postgresStorage.ingestInboundMessage(input, context);
  const paths = getStoragePaths(context);
  await fs.mkdir(paths.baseDir, { recursive: true });
  const inboundPath = path.join(paths.baseDir, 'inbound_messages.jsonl');
  const idempotencyKey = input.idempotency_key || buildIdempotencyKey(paths.tenantId, input);
  const leadFingerprint = buildLeadFingerprint(paths.tenantId, input);
  const inboundMessages = await readJsonl(inboundPath);
  const existingMessage = inboundMessages.find((message) =>
    message.idempotency_key === idempotencyKey ||
    (leadFingerprint && message.lead_fingerprint === leadFingerprint)
  );

  if (existingMessage) {
    const existingRun = (await listOfferRuns(1000, paths)).find((run) => run.inbound_message_id === existingMessage.id);
    if (existingRun) {
      await appendOfferRunEvent(existingRun.id, {
        event_type: 'email_deduplicated',
        level: 'info',
        message: 'Duplicate inbound message ignored',
        metadata: { idempotency_key: idempotencyKey, lead_fingerprint: leadFingerprint || null }
      }, paths);
    }
    return { duplicate: true, message: existingMessage, run: existingRun || null };
  }

  const now = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    dealer_id: paths.tenantId,
    provider: input.provider || 'gmail',
    provider_message_id: input.provider_message_id || input.id || crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    lead_fingerprint: leadFingerprint || null,
    subject: input.subject || input.Subject || '',
    from_email: input.from_email || input.from || '',
    to_email: input.to_email || input.to || '',
    received_at: input.received_at || now,
    raw_html: input.raw_html || input.html || '',
    raw_text: input.raw_text || input.text || '',
    status: 'received',
    created_at: now
  };
  await appendJsonl(inboundPath, message);

  const run = await createOfferRun(message, paths);
  await appendOfferRunEvent(run.id, {
    event_type: 'email_received',
    level: 'info',
    message: 'Inbound email received',
    metadata: { provider: message.provider, provider_message_id: message.provider_message_id, lead_fingerprint: message.lead_fingerprint }
  }, paths);
  return { duplicate: false, message, run };
}

export async function createOfferRun(inboundMessage, context = {}) {
  if (usePostgresStorage()) return postgresStorage.createOfferRun(inboundMessage, context);
  const paths = getStoragePaths(context);
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(),
    dealer_id: paths.tenantId,
    inbound_message_id: inboundMessage.id,
    customer_id: null,
    status: 'received',
    processing_version: 'local-v1',
    inventory_snapshot_id: null,
    price_rule_id: null,
    error_code: null,
    error_message: null,
    retry_count: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    summary: {}
  };
  await appendJsonl(path.join(paths.baseDir, 'offer_runs.jsonl'), run);
  return run;
}

export async function listOfferRuns(limit = 50, context = {}) {
  if (usePostgresStorage()) return postgresStorage.listOfferRuns(limit, context);
  const paths = getStoragePaths(context);
  const runs = await readJsonl(path.join(paths.baseDir, 'offer_runs.jsonl'));
  return runs.slice(-limit).reverse();
}

export async function loadOfferRun(runId, context = {}) {
  if (usePostgresStorage()) return postgresStorage.loadOfferRun(runId, context);
  const paths = getStoragePaths(context);
  const runs = await readJsonl(path.join(paths.baseDir, 'offer_runs.jsonl'));
  const run = runs.find((entry) => entry.id === runId);
  if (!run) return null;
  const inbound = (await readJsonl(path.join(paths.baseDir, 'inbound_messages.jsonl'))).find((entry) => entry.id === run.inbound_message_id) || null;
  const events = (await readJsonl(path.join(paths.baseDir, 'offer_run_events.jsonl'))).filter((event) => event.offer_run_id === runId);
  const draft = (await readJsonl(path.join(paths.baseDir, 'generated_drafts.jsonl'))).reverse().find((entry) => entry.offer_run_id === runId) || null;
  return { ...run, inbound_message: inbound, events, draft };
}

export async function updateOfferRun(runId, patch, context = {}) {
  if (usePostgresStorage()) return postgresStorage.updateOfferRun(runId, patch, context);
  const paths = getStoragePaths(context);
  const runsPath = path.join(paths.baseDir, 'offer_runs.jsonl');
  const runs = await readJsonl(runsPath);
  const index = runs.findIndex((run) => run.id === runId);
  if (index === -1) return null;
  runs[index] = { ...runs[index], ...patch, updated_at: new Date().toISOString() };
  await writeJsonl(runsPath, runs);
  return runs[index];
}

export async function appendOfferRunEvent(runId, event, context = {}) {
  if (usePostgresStorage()) return postgresStorage.appendOfferRunEvent(runId, event, context);
  const paths = getStoragePaths(context);
  const record = {
    id: crypto.randomUUID(),
    dealer_id: paths.tenantId,
    offer_run_id: runId,
    event_type: event.event_type,
    level: event.level || 'info',
    message: event.message || '',
    metadata_json: event.metadata || event.metadata_json || {},
    created_at: new Date().toISOString()
  };
  await appendJsonl(path.join(paths.baseDir, 'offer_run_events.jsonl'), record);
  return record;
}

export async function saveGeneratedDraft(runId, draft, context = {}) {
  if (usePostgresStorage()) return postgresStorage.saveGeneratedDraft(runId, draft, context);
  const paths = getStoragePaths(context);
  const record = {
    id: crypto.randomUUID(),
    dealer_id: paths.tenantId,
    offer_run_id: runId,
    subject: draft.betreff || draft.subject || '',
    html_body: draft.html_angebot || draft.html || '',
    text_body: draft.text || '',
    customer_email: draft.email || '',
    owner_email: draft.owner_email || '',
    status: 'created',
    created_at: new Date().toISOString()
  };
  await appendJsonl(path.join(paths.baseDir, 'generated_drafts.jsonl'), record);
  return record;
}

export function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(status);
}

export function getOnboardingChecklist(tenant, settings, dataStatus = {}) {
  return [
    {
      id: 'company',
      label: 'Firma und Signatur',
      done: Boolean(settings.signature?.company && settings.signature?.name && settings.signature?.email)
    },
    {
      id: 'pricing',
      label: 'Preislogik',
      done: Number.isFinite(Number(settings.pricing?.offerFactor)) && Number.isFinite(Number(settings.pricing?.vatRate))
    },
    {
      id: 'recipient',
      label: 'Interner Empfänger',
      done: Boolean(settings.mail?.to && settings.mail?.subject)
    },
    {
      id: 'inventory',
      label: 'Lager-/Preisdaten',
      done: dataStatus.lagerCsvExists === true || tenant.onboarding.inventoryConnected === true
    },
    {
      id: 'google',
      label: 'Google Zugriff',
      done: tenant.onboarding.googleConnected === true
    }
  ];
}

async function loadSeedTenant(paths) {
  try {
    if (paths.tenantPath !== TENANT_PATH) {
      const tenant = JSON.parse(await fs.readFile(TENANT_PATH, 'utf8'));
      return { ...tenant, id: paths.tenantId };
    }
  } catch {}
  return defaultTenant(paths.tenantId);
}

function getStoragePaths(context = {}) {
  if (context.tenantPath && context.offersPath && context.baseDir) return context;
  return tenantContext(context);
}

function defaultTenant(tenantId = 'daltec-local') {
  return {
    id: tenantId,
    name: 'Daltec GmbH',
    plan: 'local-prototype',
    onboarding: {
      googleConnected: false,
      inventoryConnected: false,
      firstOfferCreated: false,
      completedAt: null
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function buildIdempotencyKey(tenantId, input) {
  const provider = input.provider || 'gmail';
  const messageId = input.provider_message_id || input.id || '';
  if (messageId) return `${tenantId}:${provider}:${messageId}`;
  const subject = String(input.subject || input.Subject || '').trim().toLowerCase();
  const receivedAt = input.received_at || '';
  return `${tenantId}:${provider}:${subject}:${receivedAt}`;
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
}
