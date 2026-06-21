import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { tenantContext } from '../src/tenant-context.js';
import { loadOfferRun } from '../src/storage.js';

dotenv.config({ path: '.env.production' });
dotenv.config();

const file = process.argv[2] || 'data/last-proof-report-proof-only.json';
const tenantId = process.argv[3] || process.env.ADMIN_TENANT_ID || 'daltec-local';
const raw = await fs.readFile(file, 'utf8');
const json = raw.slice(raw.indexOf('{'));
const report = JSON.parse(json);
const context = tenantContext({ tenantId });
const needsReview = report.results.filter((result) => !result.duplicate && result.status === 'needs_review');
const rows = [];

for (const result of needsReview) {
  const run = await loadOfferRun(result.runId, context);
  const match = run?.match_json || {};
  const pricing = run?.pricing_json || {};
  rows.push({
    runId: result.runId,
    customer: result.customer,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    subject: run?.inbound_message?.subject || '',
    lineItems: (run?.line_items_json || []).map((item) => ({
      name: item.produkt_name_original,
      sku: item.artikelnummer || null,
      price: item.preis_mail_brutto_num || null,
      unsupportedCurrency: item.unsupported_currency || null
    })),
    requested: {
      type: match.requested_type || null,
      length: match.requested_length || null,
      width: match.requested_width || null,
      weight: match.requested_weight || null,
      skus: match.requested_skus || []
    },
    matched: {
      item: match.matched_item || null,
      sku: match.matched_sku || null,
      type: match.matched_type || null,
      length: match.matched_length || null,
      width: match.matched_width || null,
      weight: match.matched_weight || null,
      stockQty: match.stock_qty ?? null,
      score: match.matchScore ?? match.score ?? null,
      confidence: match.confidence || null
    },
    reasons: match.reasons || [],
    warnings: [
      ...(match.warnings || []),
      ...(pricing.warnings || [])
    ]
  });
}

const grouped = rows.reduce((acc, row) => {
  acc[row.errorCode] ||= 0;
  acc[row.errorCode] += 1;
  return acc;
}, {});

console.log(JSON.stringify({
  tenantId,
  total: report.total,
  unique: report.proof?.uniqueCount,
  completedRate: report.proof?.completedRate,
  needsReviewCount: rows.length,
  grouped,
  rows
}, null, 2));
