import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import { atomicWriteFile, decodeCsvBuffer, parseCsvObjectsFromText } from './adapters/local-data.js';
import { validateInventoryCsv } from './core/csv-validator.js';
import { loadTenant, saveTenant } from './storage.js';

const CANONICAL_HEADERS = [
  'Art.-Nr.',
  'Art.-Bez.',
  'Lagermenge',
  'Lagerwert',
  'Länge',
  'Breite',
  'hzGGew',
  'Ser.-Nr. (int)',
  'Standort'
];

const FIELD_ALIASES = {
  sku: ['artnr', 'artnr.', 'art-nr', 'artikelnummer', 'produktcode', 'sku', 'itemnumber', 'artikel'],
  name: ['artbez', 'artbez.', 'artikelbezeichnung', 'bezeichnung', 'beschreibung', 'typ', 'name', 'description'],
  stock: ['lagermenge', 'verflagermenge', 'bestand', 'lager', 'verfuegbar', 'verfügbar', 'qty', 'quantity', 'stock'],
  stockValue: ['lagerwert', 'ek', 'einkaufspreis', 'preis', 'price', 'cost', 'value', 'nettopreis', 'wert', 'uvp', 'bruttopreis'],
  length: ['laenge', 'länge', 'lange', 'length', 'l'],
  width: ['breite', 'width', 'b'],
  weight: ['hzggew', 'hzgggew', 'hzgg', 'hzgggewkg', 'gewicht', 'kg', 'totalgewicht', 'zgg'],
  serial: ['sernrint', 'sernr', 'seriennummer', 'fin', 'vin'],
  location: ['standort', 'lagerort', 'filiale', 'location']
};

const CANONICAL_BY_FIELD = {
  sku: 'Art.-Nr.',
  name: 'Art.-Bez.',
  stock: 'Lagermenge',
  stockValue: 'Lagerwert',
  length: 'Länge',
  width: 'Breite',
  weight: 'hzGGew',
  serial: 'Ser.-Nr. (int)',
  location: 'Standort'
};

export function isInventoryImportMessage(message = {}, settings = {}) {
  const subject = `${message.subject || ''} ${message.text || ''}`.toLowerCase();
  const attachments = message.attachments || [];
  const hasInventoryAttachment = attachments.some(isInventoryAttachment);
  if (!hasInventoryAttachment) return false;
  const configuredAddress = String(settings.data?.inventoryImportEmail || settings.onboarding?.inventoryImportEmail || '').toLowerCase();
  const to = String(message.to || '').toLowerCase();
  const explicitAddressMatch = configuredAddress && to.includes(configuredAddress);
  const subjectMatch = /\b(lager|bestand|inventory|stock|fahrzeugliste|lagerliste|eduard lager)\b/i.test(subject);
  return explicitAddressMatch || subjectMatch;
}

export async function processInventoryImportMessage(message, settings, context, options = {}) {
  const attachments = (message.attachments || []).filter(isInventoryAttachment);
  const selected = chooseInventoryAttachment(attachments);
  if (!selected) {
    const result = await recordInventoryImport(context, {
      status: 'failed',
      source: sourceFromMessage(message),
      errors: [{ code: 'missing_attachment', message: 'Keine CSV/XLSX-Lagerdatei gefunden.' }],
      warnings: []
    });
    return { ok: false, import: result };
  }

  try {
    const rows = await parseAttachmentRows(selected);
    const mapped = mapInventoryRows(rows);
    const csv = inventoryRowsToCsv(mapped.rows);
    const validation = validateInventoryCsv(csv);
    const importRecord = await recordInventoryImport(context, {
      status: validation.ok ? 'success' : 'failed',
      source: sourceFromMessage(message, selected),
      rowCount: mapped.rows.length,
      mapping: mapped.mapping,
      errors: validation.errors,
      warnings: [...mapped.warnings, ...validation.warnings],
      stats: validation.stats
    });

    if (!validation.ok) {
      return { ok: false, import: importRecord, validation };
    }

    const targetPath = settings.data?.lagerCsvPath || context.inventoryPath;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await atomicWriteFile(targetPath, csv);
    await markInventoryConnected(context);
    return { ok: true, import: importRecord, validation, targetPath };
  } catch (error) {
    const importRecord = await recordInventoryImport(context, {
      status: 'failed',
      source: sourceFromMessage(message, selected),
      errors: [{ code: 'parse_failed', message: error.message }],
      warnings: []
    });
    return { ok: false, import: importRecord };
  } finally {
    if (options.cleanup !== false) {
      // Hook for future temp files. Buffers are kept in memory today.
    }
  }
}

export async function listInventoryImports(limit = 20, context = {}) {
  const records = await readInventoryImportRecords(context);
  return records.slice(-limit).reverse();
}

export function buildInventoryImportFailureMail(result, settings = {}) {
  const errors = result.import?.errors || result.validation?.errors || [];
  const warnings = result.import?.warnings || result.validation?.warnings || [];
  const rows = errors.slice(0, 12).map((error) => `<li><strong>${escapeHtml(error.code)}</strong>: ${escapeHtml(error.message)}</li>`).join('');
  const warningRows = warnings.slice(0, 8).map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join('');
  const sample = CANONICAL_HEADERS.join(';');
  return {
    subject: 'Lagerimport fehlgeschlagen',
    html: `<!doctype html>
      <html lang="de">
        <head><meta charset="utf-8"></head>
        <body style="font-family:Arial,sans-serif;color:#111827;background:#f6f7f9;margin:0;padding:18px;">
          <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e1e5eb;border-radius:8px;padding:16px;">
            <h1 style="font-size:20px;margin:0 0 8px;">Lagerliste konnte nicht importiert werden</h1>
            <p style="margin:0 0 12px;color:#4b5563;">Bitte den Export korrigieren und erneut senden. Das System erwartet mindestens Artikelnummer, Bezeichnung, Bestand und Lagerwert/Preis.</p>
            <ul>${rows || '<li>Unbekannter Fehler beim Lesen der Datei.</li>'}</ul>
            ${warningRows ? `<p style="font-weight:bold;margin:14px 0 6px;">Hinweise</p><ul>${warningRows}</ul>` : ''}
            <p style="font-weight:bold;margin:14px 0 6px;">Minimalformat</p>
            <pre style="white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:10px;border-radius:6px;">${escapeHtml(sample)}</pre>
            <p style="margin:14px 0 0;color:#667085;font-size:12px;">${escapeHtml(settings.signature?.company || 'Eduard Angebots-Automation')}</p>
          </div>
        </body>
      </html>`
  };
}

function isInventoryAttachment(attachment = {}) {
  const filename = String(attachment.filename || attachment.name || '').toLowerCase();
  return /\.(csv|xlsx|xls)$/i.test(filename);
}

function chooseInventoryAttachment(attachments) {
  return attachments
    .slice()
    .sort((a, b) => Number(b.size || b.data?.length || 0) - Number(a.size || a.data?.length || 0))[0] || null;
}

async function parseAttachmentRows(attachment) {
  const filename = String(attachment.filename || attachment.name || '').toLowerCase();
  const buffer = Buffer.isBuffer(attachment.data)
    ? attachment.data
    : Buffer.from(attachment.data || attachment.contentBytes || '', attachment.encoding || 'base64');

  if (/\.csv$/i.test(filename)) {
    return parseCsvObjectsFromText(decodeCsvBuffer(buffer));
  }

  const sheetRows = await readXlsxFile(buffer);
  if (!sheetRows.length) return [];
  const headers = sheetRows[0].map((cell) => normalizeCell(cell));
  return sheetRows.slice(1)
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, normalizeCell(row[index])])))
    .filter((row) => Object.values(row).some((value) => String(value || '').trim() !== ''));
}

function mapInventoryRows(rows = []) {
  if (!rows.length) return { rows: [], mapping: {}, warnings: [] };
  const headers = Object.keys(rows[0] || {});
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    mapping[field] = findHeader(headers, aliases);
  }
  const warnings = [];
  for (const field of ['length', 'width', 'weight']) {
    if (!mapping[field]) warnings.push({ code: `mapping_missing_${field}`, message: `Optionale Spalte nicht erkannt: ${CANONICAL_BY_FIELD[field]}` });
  }

  const mappedRows = rows.map((row) => {
    const out = Object.fromEntries(CANONICAL_HEADERS.map((header) => [header, '']));
    for (const [field, header] of Object.entries(mapping)) {
      if (!header) continue;
      out[CANONICAL_BY_FIELD[field]] = normalizeCell(row[header]);
    }
    return out;
  });

  return { rows: mappedRows, mapping, warnings };
}

function inventoryRowsToCsv(rows) {
  const lines = [CANONICAL_HEADERS.join(';')];
  for (const row of rows) {
    lines.push(CANONICAL_HEADERS.map((header) => csvCell(row[header])).join(';'));
  }
  return `${lines.join('\n')}\n`;
}

function findHeader(headers, aliases) {
  const normalized = headers.map((header) => ({ header, key: normalizeHeader(header) }));
  for (const alias of aliases) {
    const wanted = normalizeHeader(alias);
    const exact = normalized.find((entry) => entry.key === wanted);
    if (exact) return exact.header;
  }
  for (const alias of aliases) {
    const wanted = normalizeHeader(alias);
    const partial = normalized.find((entry) => entry.key.includes(wanted) || wanted.includes(entry.key));
    if (partial) return partial.header;
  }
  return '';
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function csvCell(value) {
  const text = normalizeCell(value);
  if (!/[;"\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function recordInventoryImport(context, record) {
  const fullRecord = {
    id: crypto.randomUUID(),
    tenantId: context.tenantId,
    createdAt: new Date().toISOString(),
    status: record.status || 'failed',
    source: record.source || {},
    rowCount: record.rowCount || 0,
    mapping: record.mapping || {},
    errors: record.errors || [],
    warnings: record.warnings || [],
    stats: record.stats || null
  };
  const filePath = inventoryImportsPath(context);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(fullRecord)}\n`, 'utf8');
  return fullRecord;
}

async function readInventoryImportRecords(context) {
  try {
    const content = await fs.readFile(inventoryImportsPath(context), 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function inventoryImportsPath(context) {
  return path.join(context.baseDir || path.join('data', 'tenants', context.tenantId || 'daltec-local'), 'inventory_imports.jsonl');
}

function sourceFromMessage(message = {}, attachment = {}) {
  return {
    providerMessageId: message.id || message.provider_message_id || null,
    subject: message.subject || '',
    from: message.from || message.from_email || '',
    to: message.to || message.to_email || '',
    receivedAt: message.received_at || new Date().toISOString(),
    filename: attachment.filename || attachment.name || null,
    mimeType: attachment.mimeType || attachment.contentType || null,
    size: attachment.size || attachment.data?.length || null
  };
}

async function markInventoryConnected(context) {
  const tenant = await loadTenant(context);
  await saveTenant({
    ...tenant,
    onboarding: {
      ...(tenant.onboarding || {}),
      inventoryConnected: true
    }
  }, context);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
