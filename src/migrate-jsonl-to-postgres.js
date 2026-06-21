import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { ensurePostgresSchema } from './postgres-storage.js';

const { Pool } = pg;

const DATA_ROOT = path.resolve(process.argv[2] || 'data');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt. Migration abgebrochen.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

try {
  await ensurePostgresSchema(pool);
  const tenants = await findTenantDirs(DATA_ROOT);
  let counts = {
    tenants: 0,
    offers: 0,
    inboundMessages: 0,
    offerRuns: 0,
    events: 0,
    drafts: 0
  };

  for (const tenantDir of tenants) {
    const tenantId = path.basename(tenantDir);
    counts.tenants += await migrateTenant(tenantDir, tenantId);
    counts.offers += await migrateOffers(tenantDir, tenantId);
    counts.inboundMessages += await migrateInboundMessages(tenantDir, tenantId);
    counts.offerRuns += await migrateOfferRuns(tenantDir, tenantId);
    counts.events += await migrateEvents(tenantDir, tenantId);
    counts.drafts += await migrateDrafts(tenantDir, tenantId);
  }

  console.log(JSON.stringify({ ok: true, dataRoot: DATA_ROOT, counts }, null, 2));
} finally {
  await pool.end();
}

async function findTenantDirs(dataRoot) {
  const tenantsRoot = path.join(dataRoot, 'tenants');
  try {
    const entries = await fs.readdir(tenantsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(tenantsRoot, entry.name));
  } catch {
    return [];
  }
}

async function migrateTenant(tenantDir, tenantId) {
  const tenant = await readJson(path.join(tenantDir, 'tenant.json'));
  if (!tenant) return 0;
  const now = new Date().toISOString();
  const data = { ...tenant, id: tenantId, updatedAt: tenant.updatedAt || now };
  await pool.query(
    `INSERT INTO tenants (id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [tenantId, jsonb(data), tenant.createdAt || now, data.updatedAt]
  );
  return 1;
}

async function migrateOffers(tenantDir, tenantId) {
  const offers = await readJsonl(path.join(tenantDir, 'offers.jsonl'));
  for (const offer of offers) {
    await pool.query(
      `INSERT INTO offers (id, dealer_id, data, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [offer.id, tenantId, jsonb(offer), offer.createdAt || offer.created_at || new Date().toISOString()]
    );
  }
  return offers.length;
}

async function migrateInboundMessages(tenantDir, tenantId) {
  const messages = await readJsonl(path.join(tenantDir, 'inbound_messages.jsonl'));
  for (const message of messages) {
    await pool.query(
      `INSERT INTO inbound_messages
       (id, dealer_id, provider, provider_message_id, idempotency_key, lead_fingerprint, subject, from_email, to_email, received_at, raw_html, raw_text, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         provider = EXCLUDED.provider,
         provider_message_id = EXCLUDED.provider_message_id,
         idempotency_key = EXCLUDED.idempotency_key,
         lead_fingerprint = EXCLUDED.lead_fingerprint,
         subject = EXCLUDED.subject,
         from_email = EXCLUDED.from_email,
         to_email = EXCLUDED.to_email,
         received_at = EXCLUDED.received_at,
         raw_html = EXCLUDED.raw_html,
         raw_text = EXCLUDED.raw_text,
         status = EXCLUDED.status`,
      [
        message.id,
        tenantId,
        message.provider || 'gmail',
        message.provider_message_id || message.id,
        message.idempotency_key || `${tenantId}:${message.provider || 'gmail'}:${message.provider_message_id || message.id}`,
        message.lead_fingerprint || null,
        message.subject || '',
        message.from_email || '',
        message.to_email || '',
        message.received_at || message.created_at || new Date().toISOString(),
        message.raw_html || '',
        message.raw_text || '',
        message.status || 'received',
        message.created_at || new Date().toISOString()
      ]
    );
  }
  return messages.length;
}

async function migrateOfferRuns(tenantDir, tenantId) {
  const runs = await readJsonl(path.join(tenantDir, 'offer_runs.jsonl'));
  for (const run of runs) {
    await pool.query(
      `INSERT INTO offer_runs
       (id, dealer_id, inbound_message_id, customer_id, status, processing_version, inventory_snapshot_id, price_rule_id, error_code, error_message, retry_count, created_at, started_at, completed_at, updated_at, raw_input, config_snapshot, customer_json, line_items_json, pricing_json, match_json, draft_subject, draft_html, owner_feedback, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         completed_at = EXCLUDED.completed_at,
         updated_at = EXCLUDED.updated_at,
         raw_input = EXCLUDED.raw_input,
         config_snapshot = EXCLUDED.config_snapshot,
         customer_json = EXCLUDED.customer_json,
         line_items_json = EXCLUDED.line_items_json,
         pricing_json = EXCLUDED.pricing_json,
         match_json = EXCLUDED.match_json,
         draft_subject = EXCLUDED.draft_subject,
         draft_html = EXCLUDED.draft_html,
         owner_feedback = EXCLUDED.owner_feedback,
         summary = EXCLUDED.summary`,
      [
        run.id,
        tenantId,
        run.inbound_message_id,
        run.customer_id || null,
        run.status || 'received',
        run.processing_version || 'jsonl-migrated',
        run.inventory_snapshot_id || null,
        run.price_rule_id || null,
        run.error_code || null,
        run.error_message || null,
        Number(run.retry_count || 0),
        run.created_at || new Date().toISOString(),
        run.started_at || null,
        run.completed_at || null,
        run.updated_at || null,
        jsonb(run.raw_input),
        jsonb(run.config_snapshot),
        jsonb(run.customer_json),
        jsonb(run.line_items_json),
        jsonb(run.pricing_json),
        jsonb(run.match_json),
        run.draft_subject || null,
        run.draft_html || null,
        jsonb(run.owner_feedback),
        jsonb(run.summary || {})
      ]
    );
  }
  return runs.length;
}

async function migrateEvents(tenantDir, tenantId) {
  const events = await readJsonl(path.join(tenantDir, 'offer_run_events.jsonl'));
  for (const event of events) {
    await pool.query(
      `INSERT INTO offer_run_events
       (id, dealer_id, offer_run_id, event_type, level, message, metadata_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         event_type = EXCLUDED.event_type,
         level = EXCLUDED.level,
         message = EXCLUDED.message,
         metadata_json = EXCLUDED.metadata_json`,
      [
        event.id,
        tenantId,
        event.offer_run_id,
        event.event_type,
        event.level || 'info',
        event.message || '',
        jsonb(event.metadata_json || event.metadata || {}),
        event.created_at || new Date().toISOString()
      ]
    );
  }
  return events.length;
}

async function migrateDrafts(tenantDir, tenantId) {
  const drafts = await readJsonl(path.join(tenantDir, 'generated_drafts.jsonl'));
  for (const draft of drafts) {
    await pool.query(
      `INSERT INTO generated_drafts
       (id, dealer_id, offer_run_id, subject, html_body, text_body, customer_email, owner_email, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         html_body = EXCLUDED.html_body,
         text_body = EXCLUDED.text_body,
         status = EXCLUDED.status`,
      [
        draft.id,
        tenantId,
        draft.offer_run_id,
        draft.subject || '',
        draft.html_body || '',
        draft.text_body || '',
        draft.customer_email || '',
        draft.owner_email || '',
        draft.status || 'created',
        draft.created_at || new Date().toISOString()
      ]
    );
  }
  return drafts.length;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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
