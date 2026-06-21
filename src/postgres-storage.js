import crypto from 'node:crypto';
import pg from 'pg';
import { buildLeadFingerprint } from './lead-fingerprint.js';

const { Pool } = pg;
const JSONB_FIELDS = new Set([
  'raw_input',
  'config_snapshot',
  'customer_json',
  'line_items_json',
  'pricing_json',
  'match_json',
  'owner_feedback',
  'summary'
]);

const ACTIVE_RUN_STATUSES = new Set(['received', 'parsing', 'parsed', 'matching', 'pricing', 'drafting', 'completed', 'needs_review']);

let pool;
let schemaReady;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

export async function ensurePostgresSchema(client = getPool()) {
  if (schemaReady) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offers (
      id UUID PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_messages (
      id UUID PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      lead_fingerprint TEXT,
      subject TEXT,
      from_email TEXT,
      to_email TEXT,
      received_at TEXT,
      raw_html TEXT,
      raw_text TEXT,
      status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_idempotency_idx
      ON inbound_messages (dealer_id, idempotency_key);

    CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_fingerprint_idx
      ON inbound_messages (dealer_id, lead_fingerprint)
      WHERE lead_fingerprint IS NOT NULL AND lead_fingerprint <> '';

    CREATE TABLE IF NOT EXISTS offer_runs (
      id UUID PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      inbound_message_id UUID NOT NULL,
      customer_id TEXT,
      status TEXT NOT NULL,
      processing_version TEXT,
      inventory_snapshot_id TEXT,
      price_rule_id TEXT,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT,
      raw_input JSONB,
      config_snapshot JSONB,
      customer_json JSONB,
      line_items_json JSONB,
      pricing_json JSONB,
      match_json JSONB,
      draft_subject TEXT,
      draft_html TEXT,
      owner_feedback JSONB,
      summary JSONB DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS offer_runs_dealer_created_idx
      ON offer_runs (dealer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS offer_runs_inbound_idx
      ON offer_runs (dealer_id, inbound_message_id);

    CREATE TABLE IF NOT EXISTS offer_run_events (
      id UUID PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      offer_run_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT,
      metadata_json JSONB DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS offer_run_events_run_idx
      ON offer_run_events (offer_run_id, created_at);

    CREATE TABLE IF NOT EXISTS generated_drafts (
      id UUID PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      offer_run_id UUID NOT NULL,
      subject TEXT,
      html_body TEXT,
      text_body TEXT,
      customer_email TEXT,
      owner_email TEXT,
      status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS generated_drafts_run_idx
      ON generated_drafts (offer_run_id, created_at DESC);
  `);
  schemaReady = true;
}

function tenantIdFromContext(context = {}) {
  return context.tenantId || context.id || 'daltec-local';
}

function defaultTenant(tenantId = 'daltec-local') {
  return {
    id: tenantId,
    name: 'Daltec GmbH',
    plan: 'postgres-flight-recorder',
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

export async function loadTenant(context = {}) {
  await ensurePostgresSchema();
  const tenantId = tenantIdFromContext(context);
  const result = await getPool().query('SELECT data FROM tenants WHERE id = $1', [tenantId]);
  if (result.rows[0]) return result.rows[0].data;
  const tenant = defaultTenant(tenantId);
  await saveTenant(tenant, context);
  return tenant;
}

export async function saveTenant(input, context = {}) {
  await ensurePostgresSchema();
  const tenantId = tenantIdFromContext(context);
  const now = new Date().toISOString();
  const tenant = {
    ...defaultTenant(tenantId),
    ...input,
    id: tenantId,
    onboarding: {
      ...defaultTenant(tenantId).onboarding,
      ...(input?.onboarding || {})
    },
    updatedAt: now
  };
  await getPool().query(
    `INSERT INTO tenants (id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [tenantId, jsonb(tenant), tenant.createdAt || now, now]
  );
  return tenant;
}

export async function appendOfferRecord(workflowResult, source = {}, context = {}) {
  await ensurePostgresSchema();
  const dealerId = tenantIdFromContext(context);
  const record = {
    id: crypto.randomUUID(),
    tenantId: dealerId,
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
  await getPool().query(
    'INSERT INTO offers (id, dealer_id, data, created_at) VALUES ($1, $2, $3, $4)',
    [record.id, dealerId, jsonb(record), record.createdAt]
  );
  return record;
}

export async function listOfferRecords(limit = 50, context = {}) {
  await ensurePostgresSchema();
  const result = await getPool().query(
    'SELECT data FROM offers WHERE dealer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [tenantIdFromContext(context), limit]
  );
  return result.rows.map((row) => row.data);
}

export async function ingestInboundMessage(input, context = {}) {
  await ensurePostgresSchema();
  const client = await getPool().connect();
  const dealerId = tenantIdFromContext(context);
  const idempotencyKey = input.idempotency_key || buildIdempotencyKey(dealerId, input);
  const leadFingerprint = buildLeadFingerprint(dealerId, input);

  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      `SELECT * FROM inbound_messages
       WHERE dealer_id = $1 AND (idempotency_key = $2 OR ($3 <> '' AND lead_fingerprint = $3))
       LIMIT 1`,
      [dealerId, idempotencyKey, leadFingerprint || '']
    );

    if (existingResult.rows[0]) {
      const existingMessage = normalizeInbound(existingResult.rows[0]);
      const existingRun = await findRunByInbound(client, dealerId, existingMessage.id);
      if (existingRun) {
        await insertOfferRunEvent(client, existingRun.id, {
          event_type: 'email_deduplicated',
          level: 'info',
          message: 'Duplicate inbound message ignored',
          metadata: { idempotency_key: idempotencyKey, lead_fingerprint: leadFingerprint || null }
        }, { tenantId: dealerId });
      }
      await client.query('COMMIT');
      return { duplicate: true, message: existingMessage, run: existingRun || null };
    }

    const now = new Date().toISOString();
    const message = {
      id: crypto.randomUUID(),
      dealer_id: dealerId,
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

    await client.query(
      `INSERT INTO inbound_messages
       (id, dealer_id, provider, provider_message_id, idempotency_key, lead_fingerprint, subject, from_email, to_email, received_at, raw_html, raw_text, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        message.id,
        message.dealer_id,
        message.provider,
        message.provider_message_id,
        message.idempotency_key,
        message.lead_fingerprint,
        message.subject,
        message.from_email,
        message.to_email,
        message.received_at,
        message.raw_html,
        message.raw_text,
        message.status,
        message.created_at
      ]
    );

    const run = await insertOfferRun(client, message, { tenantId: dealerId });
    await insertOfferRunEvent(client, run.id, {
      event_type: 'email_received',
      level: 'info',
      message: 'Inbound email received',
      metadata: { provider: message.provider, provider_message_id: message.provider_message_id, lead_fingerprint: message.lead_fingerprint }
    }, { tenantId: dealerId });
    await client.query('COMMIT');
    return { duplicate: false, message, run };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return ingestInboundMessage(input, context);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createOfferRun(inboundMessage, context = {}) {
  await ensurePostgresSchema();
  return insertOfferRun(getPool(), inboundMessage, context);
}

export async function listOfferRuns(limit = 50, context = {}) {
  await ensurePostgresSchema();
  const result = await getPool().query(
    'SELECT * FROM offer_runs WHERE dealer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [tenantIdFromContext(context), limit]
  );
  return result.rows.map(normalizeRun);
}

export async function loadOfferRun(runId, context = {}) {
  await ensurePostgresSchema();
  const dealerId = tenantIdFromContext(context);
  const runResult = await getPool().query('SELECT * FROM offer_runs WHERE dealer_id = $1 AND id = $2', [dealerId, runId]);
  if (!runResult.rows[0]) return null;
  const run = normalizeRun(runResult.rows[0]);
  const [inboundResult, eventsResult, draftResult] = await Promise.all([
    getPool().query('SELECT * FROM inbound_messages WHERE dealer_id = $1 AND id = $2', [dealerId, run.inbound_message_id]),
    getPool().query('SELECT * FROM offer_run_events WHERE dealer_id = $1 AND offer_run_id = $2 ORDER BY created_at ASC', [dealerId, runId]),
    getPool().query('SELECT * FROM generated_drafts WHERE dealer_id = $1 AND offer_run_id = $2 ORDER BY created_at DESC LIMIT 1', [dealerId, runId])
  ]);
  return {
    ...run,
    inbound_message: inboundResult.rows[0] ? normalizeInbound(inboundResult.rows[0]) : null,
    events: eventsResult.rows.map(normalizeEvent),
    draft: draftResult.rows[0] ? normalizeDraft(draftResult.rows[0]) : null
  };
}

export async function updateOfferRun(runId, patch, context = {}) {
  await ensurePostgresSchema();
  const dealerId = tenantIdFromContext(context);
  const allowed = [
    'status',
    'customer_id',
    'processing_version',
    'inventory_snapshot_id',
    'price_rule_id',
    'error_code',
    'error_message',
    'retry_count',
    'started_at',
    'completed_at',
    'raw_input',
    'config_snapshot',
    'customer_json',
    'line_items_json',
    'pricing_json',
    'match_json',
    'draft_subject',
    'draft_html',
    'owner_feedback',
    'summary'
  ];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (!entries.length) return loadOfferRun(runId, context);
  entries.push(['updated_at', new Date().toISOString()]);
  const sets = entries.map(([key], index) => `${key} = $${index + 3}`).join(', ');
  const values = entries.map(([key, value]) => JSONB_FIELDS.has(key) ? jsonb(value) : value);
  const result = await getPool().query(
    `UPDATE offer_runs SET ${sets} WHERE dealer_id = $1 AND id = $2 RETURNING *`,
    [dealerId, runId, ...values]
  );
  return result.rows[0] ? normalizeRun(result.rows[0]) : null;
}

export async function appendOfferRunEvent(runId, event, context = {}) {
  await ensurePostgresSchema();
  return insertOfferRunEvent(getPool(), runId, event, context);
}

export async function saveGeneratedDraft(runId, draft, context = {}) {
  await ensurePostgresSchema();
  const dealerId = tenantIdFromContext(context);
  const record = {
    id: crypto.randomUUID(),
    dealer_id: dealerId,
    offer_run_id: runId,
    subject: draft.betreff || draft.subject || '',
    html_body: draft.html_angebot || draft.html || '',
    text_body: draft.text || '',
    customer_email: draft.email || '',
    owner_email: draft.owner_email || '',
    status: 'created',
    created_at: new Date().toISOString()
  };
  await getPool().query(
    `INSERT INTO generated_drafts
     (id, dealer_id, offer_run_id, subject, html_body, text_body, customer_email, owner_email, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [record.id, record.dealer_id, record.offer_run_id, record.subject, record.html_body, record.text_body, record.customer_email, record.owner_email, record.status, record.created_at]
  );
  return record;
}

export function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(status);
}

async function insertOfferRun(client, inboundMessage, context = {}) {
  const dealerId = tenantIdFromContext(context);
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(),
    dealer_id: dealerId,
    inbound_message_id: inboundMessage.id,
    customer_id: null,
    status: 'received',
    processing_version: 'postgres-v1',
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
  await client.query(
    `INSERT INTO offer_runs
     (id, dealer_id, inbound_message_id, customer_id, status, processing_version, inventory_snapshot_id, price_rule_id, error_code, error_message, retry_count, created_at, started_at, completed_at, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [run.id, run.dealer_id, run.inbound_message_id, run.customer_id, run.status, run.processing_version, run.inventory_snapshot_id, run.price_rule_id, run.error_code, run.error_message, run.retry_count, run.created_at, run.started_at, run.completed_at, jsonb(run.summary)]
  );
  return run;
}

async function insertOfferRunEvent(client, runId, event, context = {}) {
  const record = {
    id: crypto.randomUUID(),
    dealer_id: tenantIdFromContext(context),
    offer_run_id: runId,
    event_type: event.event_type,
    level: event.level || 'info',
    message: event.message || '',
    metadata_json: event.metadata || event.metadata_json || {},
    created_at: new Date().toISOString()
  };
  await client.query(
    `INSERT INTO offer_run_events
     (id, dealer_id, offer_run_id, event_type, level, message, metadata_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [record.id, record.dealer_id, record.offer_run_id, record.event_type, record.level, record.message, jsonb(record.metadata_json), record.created_at]
  );
  return record;
}

async function findRunByInbound(client, dealerId, inboundMessageId) {
  const result = await client.query(
    'SELECT * FROM offer_runs WHERE dealer_id = $1 AND inbound_message_id = $2 ORDER BY created_at DESC LIMIT 1',
    [dealerId, inboundMessageId]
  );
  return result.rows[0] ? normalizeRun(result.rows[0]) : null;
}

function normalizeRun(row) {
  return {
    ...row,
    summary: row.summary || {},
    raw_input: row.raw_input || undefined,
    config_snapshot: row.config_snapshot || undefined,
    customer_json: row.customer_json || undefined,
    line_items_json: row.line_items_json || undefined,
    pricing_json: row.pricing_json || undefined,
    match_json: row.match_json || undefined,
    owner_feedback: row.owner_feedback || undefined
  };
}

function normalizeInbound(row) {
  return { ...row };
}

function normalizeEvent(row) {
  return { ...row, metadata_json: row.metadata_json || {} };
}

function normalizeDraft(row) {
  return { ...row };
}

function buildIdempotencyKey(tenantId, input) {
  const provider = input.provider || 'gmail';
  const messageId = input.provider_message_id || input.id || '';
  if (messageId) return `${tenantId}:${provider}:${messageId}`;
  const subject = String(input.subject || input.Subject || '').trim().toLowerCase();
  const receivedAt = input.received_at || '';
  return `${tenantId}:${provider}:${subject}:${receivedAt}`;
}

function jsonb(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}
