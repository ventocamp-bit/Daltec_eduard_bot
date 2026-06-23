import { loadSettings } from './settings.js';
import { fileExists, fileMetadata, readCsvObjects } from './adapters/local-data.js';
import { runWorkflow } from './workflow.js';
import { buildEditableOfferState, renderEditableOfferHtml } from './core/editable-offer.js';
import {
  appendOfferRunEvent,
  loadOfferRun,
  saveGeneratedDraft,
  updateOfferRun
} from './storage.js';

export async function processOfferRun(runId, context = {}) {
  const loaded = await loadOfferRun(runId, context);
  if (!loaded) {
    const error = new Error('run_not_found');
    error.statusCode = 404;
    throw error;
  }

  if (['parsing', 'matching', 'pricing', 'drafting'].includes(loaded.status)) {
    const error = new Error('run_already_processing');
    error.statusCode = 409;
    throw error;
  }

  await updateOfferRun(runId, { status: 'parsing', started_at: new Date().toISOString() }, context);
  await appendOfferRunEvent(runId, { event_type: 'parse_started', message: 'Parsing started' }, context);

  const settings = await loadSettings(context);
  const inventoryPath = settings.data?.lagerCsvPath || context.inventoryPath || 'data/lager.csv';
  const lagerBestand = await loadInventory(inventoryPath);
  const inventoryMeta = await inventoryFreshness(inventoryPath, settings);
  const message = {
    id: loaded.inbound_message?.provider_message_id || loaded.inbound_message_id,
    subject: loaded.inbound_message?.subject || '',
    from: loaded.inbound_message?.from_email || '',
    html: loaded.inbound_message?.raw_html || '',
    text: loaded.inbound_message?.raw_text || ''
  };

  try {
    const result = runWorkflow(message, {
      lagerBestand,
      preisliste: lagerBestand,
      settings,
      tenantContext: context
    });

    if (!result.inquiry?.line_items?.length) {
      await markRunFailure(runId, 'needs_review', 'no_valid_items', 'Keine gültigen Artikelpositionen gefunden.', context);
      return loadOfferRun(runId, context);
    }

    await updateOfferRun(runId, {
      status: 'parsed',
      customer_json: {
        first_name: result.inquiry.kunde_vorname,
        last_name: result.inquiry.kunde_nachname,
        email: result.inquiry.kunde_email,
        phone: result.inquiry.kunde_telefon,
        address: result.inquiry.kunde_adresse
      },
      line_items_json: result.inquiry.line_items,
      summary: {
        customerEmail: result.inquiry.kunde_email,
        customerName: [result.inquiry.kunde_vorname, result.inquiry.kunde_nachname].filter(Boolean).join(' '),
        lineItemCount: result.inquiry.line_items.length
      }
    }, context);
    await appendOfferRunEvent(runId, {
      event_type: 'parse_success',
      message: 'Customer and line items extracted',
      metadata: { line_items: result.inquiry.line_items.length }
    }, context);

    const unsupportedCurrency = result.inquiry.line_items.find((item) => item.unsupported_currency);
    if (unsupportedCurrency) {
      await appendOfferRunEvent(runId, {
        event_type: 'price_unsupported_currency',
        level: 'warning',
        message: `Preis in ${unsupportedCurrency.unsupported_currency} erkannt. Kein Euro-Angebot erzeugt.`,
        metadata: {
          product: unsupportedCurrency.produkt_name_original,
          currency: unsupportedCurrency.unsupported_currency,
          raw_price: unsupportedCurrency.raw_price
        }
      }, context);
      await markRunFailure(runId, 'needs_review', 'unsupported_currency', `Preis in ${unsupportedCurrency.unsupported_currency} erkannt. Bitte manuell prüfen.`, context);
      return loadOfferRun(runId, context);
    }

    const skuNotFound = result.inquiry.line_items.find((item) => item.is_sku_not_found);
    if (skuNotFound) {
      await appendOfferRunEvent(runId, {
        event_type: 'sku_not_found',
        level: 'warning',
        message: 'Eduard Informationsanfrage mit SKU NOT FOUND erkannt.',
        metadata: {
          product: skuNotFound.produkt_name_original,
          articleNumber: skuNotFound.artikelnummer || null
        }
      }, context);
      await markRunFailure(runId, 'needs_review', 'sku_not_found', 'Eduard SKU NOT FOUND. Bitte manuell bei Eduard prüfen.', context);
      return loadOfferRun(runId, context);
    }

    await updateOfferRun(runId, { status: 'matching' }, context);
    await appendOfferRunEvent(runId, { event_type: 'inventory_match_started', message: 'Inventory matching started' }, context);
    const match = summarizeMatch(result);
    await appendOfferRunEvent(runId, {
      event_type: match.hasInventoryMatch ? 'inventory_match_success' : 'inventory_match_no_match',
      level: match.hasInventoryMatch ? 'info' : 'warning',
      message: match.reason,
      metadata: match
    }, context);

    await updateOfferRun(runId, { status: 'pricing' }, context);
    await appendOfferRunEvent(runId, {
      event_type: 'price_calculated',
      message: 'Offer price calculated',
      metadata: {
        total_gross: result.matched?.kalkulation_anfrage?.gesamt_angebot_brutto || 0,
        uvp_gross: result.matched?.kalkulation_anfrage?.gesamt_uvp_brutto || 0
      }
    }, context);

    await updateOfferRun(runId, { status: 'drafting' }, context);
    const draft = await saveGeneratedDraft(runId, result.offer, context);
    await appendOfferRunEvent(runId, {
      event_type: 'draft_created',
      message: 'Owner draft created',
      metadata: { draft_id: draft.id, subject: draft.subject }
    }, context);

    const pricingWarnings = collectPricingWarnings(result);
    const hasPriceReviewWarning = pricingWarnings.length > 0;
    const minAutoInventoryScore = Number(settings.matching?.minAutoInventoryScore ?? 2000);
    const weakInventoryMatch = match.hasInventoryMatch && match.matchScore < minAutoInventoryScore;
    const finalStatus = match.hasInventoryMatch && !weakInventoryMatch && !hasPriceReviewWarning ? 'completed' : 'needs_review';
    const inventoryWarning = inventoryMeta.stale ? 'inventory_stale' : null;
    const errorCode = inventoryWarning ||
      (hasPriceReviewWarning ? pricingWarnings[0].code : null) ||
      (weakInventoryMatch ? 'weak_inventory_match' : (finalStatus === 'needs_review' ? 'no_inventory_match' : null));
    const errorMessage = inventoryWarning
      ? 'Lager-/Preis-CSV ist veraltet. Lager-Match bitte manuell prüfen.'
      : hasPriceReviewWarning
        ? pricingWarnings[0].message
        : (weakInventoryMatch ? 'Lager-Match ist schwach. Bitte manuell prüfen.' : (finalStatus === 'needs_review' ? 'Kein sicherer Lager-Match gefunden.' : null));
    await updateOfferRun(runId, {
      status: inventoryMeta.stale ? 'needs_review' : finalStatus,
      completed_at: new Date().toISOString(),
      pricing_json: result.matched?.kalkulation_anfrage || result.priced?.kalkulation_anfrage || {},
      match_json: {
        ...match,
        upsell_daten: result.matched?.upsell_daten || [],
        kalkulation_lager: result.matched?.kalkulation_lager || null,
        inventory_source: {
          type: 'local_csv',
          path: inventoryPath,
          rows_loaded: lagerBestand.length,
          last_synced_at: inventoryMeta.modifiedAt,
          age_hours: inventoryMeta.ageHours,
          stale: inventoryMeta.stale,
          max_age_hours: inventoryMeta.maxAgeHours
        }
      },
      draft_subject: result.offer?.betreff || '',
      draft_html: renderEditableOfferHtml(buildEditableOfferState({
        ...loaded,
        draft_subject: result.offer?.betreff || '',
        pricing_json: result.matched?.kalkulation_anfrage || result.priced?.kalkulation_anfrage || {},
        match_json: {
          ...match,
          upsell_daten: result.matched?.upsell_daten || [],
          kalkulation_lager: result.matched?.kalkulation_lager || null
        },
        summary: {
          customerEmail: result.inquiry.kunde_email,
          customerName: [result.inquiry.kunde_vorname, result.inquiry.kunde_nachname].filter(Boolean).join(' '),
          lineItemCount: result.inquiry.line_items.length,
          totalGross: result.matched?.kalkulation_anfrage?.gesamt_angebot_brutto || 0,
          ...match
        }
      })),
      error_code: errorCode,
      error_message: errorMessage,
      summary: {
        customerEmail: result.inquiry.kunde_email,
        customerName: [result.inquiry.kunde_vorname, result.inquiry.kunde_nachname].filter(Boolean).join(' '),
        lineItemCount: result.inquiry.line_items.length,
        totalGross: result.matched?.kalkulation_anfrage?.gesamt_angebot_brutto || 0,
        ...match
      }
    }, context);
    await appendOfferRunEvent(runId, {
      event_type: inventoryMeta.stale ? 'inventory_stale' : (hasPriceReviewWarning ? 'price_needs_review' : (finalStatus === 'completed' ? 'run_completed' : 'run_needs_review')),
      level: inventoryMeta.stale || finalStatus !== 'completed' ? 'warning' : 'info',
      message: inventoryMeta.stale ? 'Inventory CSV is stale' : (hasPriceReviewWarning ? 'Price needs owner review' : (finalStatus === 'completed' ? 'Run completed' : 'Run needs owner review')),
      metadata: { status: inventoryMeta.stale ? 'needs_review' : finalStatus, inventory: inventoryMeta, pricingWarnings, minAutoInventoryScore }
    }, context);
  } catch (error) {
    await markRunFailure(runId, 'failed_retryable', 'processing_failed', error.message, context);
  }

  return loadOfferRun(runId, context);
}
export async function setOfferRunStatus(runId, status, payload = {}, context = {}) {
  const run = await loadOfferRun(runId, context);
  if (!run) {
    const error = new Error('run_not_found');
    error.statusCode = 404;
    throw error;
  }
  const updated = await updateOfferRun(runId, {
    status,
    summary: {
      ...(run.summary || {}),
      notes: payload.notes || run.summary?.notes || null,
      lost_reason: payload.lost_reason || run.summary?.lost_reason || null,
      sale_amount: payload.sale_amount ?? run.summary?.sale_amount ?? null
    }
  }, context);
  await appendOfferRunEvent(runId, {
    event_type: 'status_changed',
    message: `Status changed to ${status}`,
    metadata: { status, ...payload }
  }, context);
  return updated;
}

export async function recordOwnerFeedback(runId, payload = {}, context = {}) {
  const run = await loadOfferRun(runId, context);
  if (!run) {
    const error = new Error('run_not_found');
    error.statusCode = 404;
    throw error;
  }

  const allowed = new Set(['sendable', 'minor_correction', 'wrong', 'rejected']);
  const rating = payload.rating || '';
  if (!allowed.has(rating)) {
    const error = new Error('invalid_feedback_rating');
    error.statusCode = 400;
    throw error;
  }

  const feedback = {
    rating,
    notes: String(payload.notes || '').trim(),
    created_at: new Date().toISOString()
  };
  const updated = await updateOfferRun(runId, {
    ...(rating === 'rejected' ? { status: 'rejected' } : {}),
    owner_feedback: feedback,
    summary: {
      ...(run.summary || {}),
      ownerFeedback: feedback
    }
  }, context);
  await appendOfferRunEvent(runId, {
    event_type: 'owner_feedback_recorded',
    level: rating === 'wrong' ? 'warning' : 'info',
    message: `Owner feedback recorded: ${rating}`,
    metadata: feedback
  }, context);
  return updated;
}

async function loadInventory(inventoryPath) {
  if (!(await fileExists(inventoryPath))) return [];
  return readCsvObjects(inventoryPath);
}

async function inventoryFreshness(inventoryPath, settings = {}) {
  const meta = await fileMetadata(inventoryPath);
  const maxAgeHours = Number(settings.data?.inventoryMaxAgeHours ?? 24);
  const ageHours = meta.modifiedAt ? (Date.now() - new Date(meta.modifiedAt).getTime()) / 36e5 : Infinity;
  return {
    ...meta,
    maxAgeHours,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    stale: !meta.exists || ageHours > maxAgeHours
  };
}

async function markRunFailure(runId, status, code, message, context) {
  await updateOfferRun(runId, {
    status,
    error_code: code,
    error_message: message,
    completed_at: new Date().toISOString()
  }, context);
  await appendOfferRunEvent(runId, {
    event_type: code,
    level: status === 'needs_review' ? 'warning' : 'error',
    message
  }, context);
}

function summarizeMatch(result) {
  const match = result.matched?.upsell_daten?.find((entry) => entry.anzahl_matches > 0) || null;
  const score = Number(match?.top_upsell?.score || 0);
  const detail = match?.top_upsell?._match || {};
  const hasInventoryMatch = result.matched?.hat_match === true;
  return {
    hasInventoryMatch,
    matchType: hasInventoryMatch ? (score >= 2000 ? 'exact_or_strong' : 'similar') : 'no_match',
    matchConfidence: hasInventoryMatch ? Math.min(1, score / 2100) : 0,
    confidence: detail.confidence || (hasInventoryMatch ? (score >= 2000 ? 'high' : score >= 1000 ? 'medium' : 'low') : 'none'),
    matchScore: score,
    topInventoryName: result.matched?.top_lager_name || null,
    requested_type: detail.requested_type || null,
    requested_length: detail.requested_length || null,
    requested_width: detail.requested_width || null,
    requested_weight: detail.requested_weight || null,
    requested_skus: detail.requested_skus || [],
    matched_item: detail.matched_item || result.matched?.top_lager_name || null,
    matched_sku: detail.matched_sku || null,
    matched_type: detail.matched_type || null,
    matched_length: detail.matched_length || null,
    matched_width: detail.matched_width || null,
    matched_weight: detail.matched_weight || null,
    stock_qty: detail.stock_qty ?? null,
    reasons: detail.reasons || [],
    warnings: detail.warnings || [],
    reason: hasInventoryMatch
      ? `Match gefunden: ${result.matched?.top_lager_name || 'Lagerfahrzeug'}`
      : 'Kein sicherer Lager-Match gefunden.'
  };
}

function collectPricingWarnings(result) {
  return [
    ...(result.matched?.kalkulation_anfrage?.warnings || []),
    ...(result.matched?.kalkulation_lager?.warnings || [])
  ].filter(Boolean);
}
