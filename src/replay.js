import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { tenantContext } from './tenant-context.js';
import { ingestInboundMessage, loadOfferRun } from './storage.js';
import { processOfferRun } from './offer-run-service.js';
import { readCsvObjects } from './adapters/local-data.js';

dotenv.config();

const args = parseArgs(process.argv.slice(2));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/replay.js')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export async function replayMessages(inputPath, options = {}) {
  const context = tenantContext({ tenantId: options.tenantId || process.env.ADMIN_TENANT_ID || 'daltec-local' });
  const seeded = await seedReplayTenant(context, options);
  const messages = await readReplayMessages(inputPath);
  const results = [];

  for (const [index, message] of messages.entries()) {
    const normalized = normalizeReplayMessage(message, index, options);
    try {
      const inbound = await ingestInboundMessage(normalized, context);
      if (inbound.duplicate) {
        results.push({
          index,
          providerMessageId: normalized.provider_message_id,
          duplicate: true,
          runId: inbound.run?.id || null,
          status: inbound.run?.status || 'duplicate',
          errorCode: inbound.run?.error_code || null,
          dangerous: false
        });
        continue;
      }

      const run = await processOfferRun(inbound.run.id, context);
      results.push(summarizeReplayRun(index, normalized, run, false));
    } catch (error) {
      results.push({
        index,
        providerMessageId: normalized.provider_message_id,
        duplicate: false,
        runId: null,
        status: 'replay_failed',
        errorCode: 'replay_exception',
        errorMessage: error.message,
        dangerous: true
      });
    }
  }

  const inventory = await inventoryProofSnapshot(context);
  return buildReplayReport(results, { seeded, inventory, targetTotal: Number(options.targetTotal || 100) });
}

async function main() {
  if (!args.file) {
    throw new Error('Bitte --file <messages.json|messages.jsonl|ordner> angeben.');
  }
  const report = await replayMessages(args.file, {
    tenantId: args.tenant || process.env.ADMIN_TENANT_ID || 'daltec-local',
    provider: args.provider || 'replay',
    prefix: args.prefix || `replay-${Date.now()}`,
    sourceTenantId: args['source-tenant'],
    targetTotal: args.target
  });
  console.log(JSON.stringify(report, null, 2));
}

async function seedReplayTenant(targetContext, options = {}) {
  if (!options.sourceTenantId) {
    return null;
  }

  const sourceContext = tenantContext({ tenantId: options.sourceTenantId });
  await fs.mkdir(targetContext.baseDir, { recursive: true });

  const seeded = {
    sourceTenantId: sourceContext.tenantId,
    targetTenantId: targetContext.tenantId,
    tenantCopied: false,
    settingsCopied: false,
    inventoryCopied: false
  };

  const sourceTenant = await readJsonIfExists(sourceContext.tenantPath);
  if (sourceTenant) {
    await fs.writeFile(targetContext.tenantPath, `${JSON.stringify({
      ...sourceTenant,
      id: targetContext.tenantId,
      name: sourceTenant.name ? `${sourceTenant.name} Proof` : `${targetContext.tenantId} Proof`,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    seeded.tenantCopied = true;
  }

  const sourceSettings = await readJsonIfExists(sourceContext.settingsPath);
  if (sourceSettings) {
    sourceSettings.data ||= {};
    sourceSettings.data.lagerCsvPath = targetContext.inventoryPath;
    await fs.writeFile(targetContext.settingsPath, `${JSON.stringify(sourceSettings, null, 2)}\n`, 'utf8');
    seeded.settingsCopied = true;
  }

  if (await fileExists(sourceContext.inventoryPath)) {
    await fs.copyFile(sourceContext.inventoryPath, targetContext.inventoryPath);
    seeded.inventoryCopied = true;
  }

  const inventory = await inventoryProofSnapshot(targetContext);
  seeded.inventoryItemCount = inventory.itemCount;

  return seeded;
}

async function readReplayMessages(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isDirectory()) {
    const files = (await fs.readdir(inputPath))
      .filter((file) => /\.(json|jsonl)$/i.test(file))
      .sort();
    const nested = await Promise.all(files.map((file) => readReplayMessages(path.join(inputPath, file))));
    return nested.flat();
  }

  const content = await fs.readFile(inputPath, 'utf8');
  if (/\.jsonl$/i.test(inputPath)) {
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeReplayMessage(message, index, options) {
  const providerMessageId = message.providerMessageId ||
    message.provider_message_id ||
    message.id ||
    `${options.prefix || 'replay'}-${index + 1}`;
  return {
    provider: options.provider || message.provider || 'replay',
    provider_message_id: providerMessageId,
    subject: message.subject || message.Subject || '',
    from_email: message.fromEmail || message.from_email || message.from || '',
    to_email: message.toEmail || message.to_email || message.to || '',
    received_at: message.receivedAt || message.received_at || new Date().toISOString(),
    raw_html: message.rawHtml || message.raw_html || message.html || '',
    raw_text: message.rawText || message.raw_text || message.text || ''
  };
}

function summarizeReplayRun(index, message, run, duplicate) {
  const dangerous = isDangerousRun(run);
  return {
    index,
    providerMessageId: message.provider_message_id,
    duplicate,
    runId: run.id,
    status: run.status,
    errorCode: run.error_code || null,
    errorMessage: run.error_message || null,
    customer: run.summary?.customerName || run.summary?.customerEmail || '',
    matchType: run.summary?.matchType || '',
    matchScore: run.summary?.matchScore || 0,
    hasDraft: Boolean(run.draft_html || run.draft?.html_body),
    hasPricingSnapshot: Boolean(run.pricing_json && Object.keys(run.pricing_json).length),
    hasMatchSnapshot: Boolean(run.match_json && Object.keys(run.match_json).length),
    dangerous
  };
}

export function buildReplayReport(results, meta = {}) {
  const counts = countBy(results, 'status');
  const errorCodes = countBy(results.filter((result) => result.errorCode), 'errorCode');
  const dangerous = results.filter((result) => result.dangerous);
  const proof = buildProofGate(results, {
    targetTotal: meta.targetTotal || 100,
    inventory: meta.inventory || { itemCount: 0 }
  });
  return {
    total: results.length,
    passed: dangerous.length === 0,
    proof,
    seeded: meta.seeded || null,
    counts,
    errorCodes,
    duplicateCount: results.filter((result) => result.duplicate).length,
    dangerousCount: dangerous.length,
    dangerous,
    results
  };
}

function buildProofGate(results, options = {}) {
  const targetTotal = Number(options.targetTotal || 100);
  const inventoryItemCount = Number(options.inventory?.itemCount || 0);
  const minInventoryItems = Number(options.inventory?.minItemCount || 15);
  const duplicateCount = results.filter((result) => result.duplicate).length;
  const uniqueCount = results.length - duplicateCount;
  const completedCount = results.filter((result) => !result.duplicate && ['completed', 'sent_to_owner'].includes(result.status)).length;
  const needsReviewCount = results.filter((result) => !result.duplicate && result.status === 'needs_review').length;
  const safeDraftCandidateCount = results.filter((result) => isSafeDraftCandidate(result)).length;
  const failedCount = results.filter((result) => !result.duplicate && String(result.status || '').startsWith('failed')).length;
  const dangerousCount = results.filter((result) => result.dangerous).length;
  const errorCodes = countBy(results.filter((result) => !result.duplicate && result.errorCode), 'errorCode');
  const completedRate = uniqueCount ? Number((completedCount / uniqueCount).toFixed(2)) : 0;
  const safeDraftCandidateRate = uniqueCount ? Number((safeDraftCandidateCount / uniqueCount).toFixed(2)) : 0;
  const needsReviewRate = uniqueCount ? Number((needsReviewCount / uniqueCount).toFixed(2)) : 0;
  const blockers = [];

  if (results.length < targetTotal) {
    blockers.push({
      code: 'proof_mail_count_low',
      message: `Nur ${results.length}/${targetTotal} Mails im Proof. Ziel: ${targetTotal} echte Eduard-Mails.`
    });
  }
  if (inventoryItemCount < minInventoryItems) {
    blockers.push({
      code: 'inventory_too_small',
      message: `Lager-/Preis-CSV hat nur ${inventoryItemCount} Position(en). Minimum für belastbaren Proof: ${minInventoryItems}.`
    });
  }
  if (dangerousCount > 0) {
    blockers.push({
      code: 'dangerous_runs',
      message: `${dangerousCount} gefaehrliche Runs gefunden.`
    });
  }
  if (failedCount > 0) {
    blockers.push({
      code: 'failed_runs',
      message: `${failedCount} Runs sind fehlgeschlagen.`
    });
  }
  if ((errorCodes.no_inventory_match || 0) + (errorCodes.weak_inventory_match || 0) > uniqueCount * 0.4) {
    blockers.push({
      code: 'inventory_match_rate_low',
      message: `${(errorCodes.no_inventory_match || 0) + (errorCodes.weak_inventory_match || 0)} von ${uniqueCount} eindeutigen Runs haben keinen sicheren Lager-Match.`
    });
  }
  if (safeDraftCandidateRate < 0.8) {
    blockers.push({
      code: 'safe_draft_candidate_rate_low',
      message: `Nur ${Math.round(safeDraftCandidateRate * 100)}% sichere Draft-Kandidaten. Ziel für DALTEC Proof: mindestens 80% plus Owner-Feedback.`
    });
  }

  const nextAction = nextProofAction(blockers, { uniqueCount, completedRate });

  return {
    readyForDaltecDailyUse: blockers.length === 0,
    targetTotal,
    total: results.length,
    uniqueCount,
    duplicateCount,
    completedCount,
    needsReviewCount,
    safeDraftCandidateCount,
    failedCount,
    dangerousCount,
    completedRate,
    safeDraftCandidateRate,
    needsReviewRate,
    inventoryItemCount,
    minInventoryItems,
    blockers,
    nextAction
  };
}

function isSafeDraftCandidate(result) {
  if (result.duplicate || result.dangerous) return false;
  if (['completed', 'sent_to_owner'].includes(result.status)) return true;
  if (result.status !== 'needs_review') return false;
  if (!result.hasDraft || !result.hasPricingSnapshot) return false;
  if (['unsupported_currency', 'sku_not_found', 'no_valid_items', 'price_missing'].includes(result.errorCode)) return false;
  return true;
}

function nextProofAction(blockers, metrics = {}) {
  if (blockers.some((blocker) => blocker.code === 'dangerous_runs')) {
    return 'Gefaehrliche Runs zuerst debuggen. Kein Livebetrieb.';
  }
  if (blockers.some((blocker) => blocker.code === 'inventory_too_small')) {
    return 'Vollstaendige Lager-/Preis-CSV hochladen und Proof erneut laufen lassen.';
  }
  if (blockers.some((blocker) => blocker.code === 'inventory_match_rate_low')) {
    return 'Lager-Matching anhand der No-Match- und Weak-Match-Runs verbessern.';
  }
  if (Number(metrics.uniqueCount || 0) >= 20 && Number(metrics.completedRate || 0) < 0.8) {
    return 'Top Needs-Review-Gruende fixen und Owner Feedback einsammeln, bevor nur mehr Mails gesammelt werden.';
  }
  if (blockers.some((blocker) => blocker.code === 'proof_mail_count_low')) {
    return 'Weitere echte Eduard-Mails exportieren oder alte Mailarchive importieren, bis 100 Proof-Mails erreicht sind.';
  }
  if (blockers.some((blocker) => blocker.code === 'safe_draft_candidate_rate_low')) {
    return 'Top Needs-Review-Gruende fixen und Owner Feedback einsammeln.';
  }
  return blockers[0]?.message || 'Owner Feedback für Safe Draft Acceptance Rate einsammeln.';
}

async function inventoryProofSnapshot(context) {
  try {
    return {
      itemCount: (await readCsvObjects(context.inventoryPath)).length
    };
  } catch {
    return { itemCount: 0 };
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDangerousRun(run) {
  if (!run) return true;
  if (String(run.status || '').startsWith('failed')) return false;
  if (run.status === 'completed' || run.status === 'sent_to_owner') {
    if (!run.pricing_json || Object.keys(run.pricing_json).length === 0) return true;
    if (!run.match_json || Object.keys(run.match_json).length === 0) return true;
    if (run.error_code && !['no_inventory_match', 'weak_inventory_match', 'inventory_stale', 'negative_discount'].includes(run.error_code)) return true;
  }
  return false;
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'none';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    if (!current.startsWith('--')) continue;
    parsed[current.slice(2)] = rawArgs[index + 1];
    index += 1;
  }
  return parsed;
}
