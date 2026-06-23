import { buildEditedDraftHtml } from '../admin/public/draft-review.js';
import { findEduardProductByCode } from './product-catalog.js';

const INVENTORY_HEADING = 'SOFORT AB LAGER VERFÜGBAR';

export const INVENTORY_ALTERNATIVE_RULES = Object.freeze({
  suggestedWhen: 'match_json.hat_match === true or match_json.hasInventoryMatch === true, and match_json.kalkulation_lager has priced rows',
  hideableWhen: 'inventory alternative is suggested',
  ownerOverrideAllowedWhen: 'inventory alternative is suggested',
  replacementWhen: 'editable_offer.inventory_alternative.enabled === true and editable_offer.inventory_alternative.replacement.enabled === true',
  sendFlowRule: 'send-to-customer renders from editable_offer when present; disabled alternatives must not re-enable, enabled replacements replace the original inventory alternative'
});

export function normalizeEditableOffer(input = {}) {
  const inventoryInput = input.inventory_alternative || {};
  const rows = Array.isArray(input.rows) ? input.rows.map((row) => ({
    type: String(row?.type || 'item'),
    product: String(row?.product || ''),
    uvpNet: String(row?.uvpNet || ''),
    discount: String(row?.discount || ''),
    offerNet: String(row?.offerNet || '')
  })) : [];
  const extraTables = Array.isArray(input.extra_tables) ? input.extra_tables : [];
  return {
    to: String(input.to || '').trim(),
    subject: String(input.subject || '').trim(),
    intro: String(input.intro || ''),
    rows,
    extra_tables: extraTables,
    notes: String(input.notes || ''),
    signature: String(input.signature || ''),
    inventory_alternative: {
      enabled: inventoryInput.enabled !== false,
      // Wenn replacement.enabled === true, wird diese Alternative statt der vorgeschlagenen verwendet.
      replacement: normalizeInventoryReplacement(inventoryInput.replacement)
    }
  };
}

export function buildEditableOfferState(run, overrides = {}) {
  const persisted = normalizeEditableOffer(run?.summary?.editable_offer || {});
  const editableOffer = normalizeEditableOffer(mergeEditableOffer(persisted, overrides.editable_offer || {}));
  const inventoryAlternative = resolveInventoryAlternativeForEditableOffer(run, editableOffer);
  const inventoryEnabled = inventoryAlternative.enabled === true;
  const customer = run?.customer_json || {};
  const customerName = run?.summary?.customerName || [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const defaultRecipient = {
    to: run?.draft?.customer_email || run?.summary?.customerEmail || customer.email || '',
    subject: run?.draft?.subject || run?.draft_subject || `Ihr Eduard Angebot${customerName ? ` - ${customerName}` : ''}`
  };
  const requestedTable = {
    role: 'requested',
    title: inventoryEnabled ? 'WUNSCH-KONFIGURATION' : '',
    rows: editableOffer.rows.length ? draftRowsFromEditableRows(editableOffer.rows) : draftRowsFromPricing(run?.pricing_json || {})
  };

  return {
    version: 1,
    run_id: run?.id || null,
    recipient: {
      to: editableOffer.to || defaultRecipient.to,
      subject: editableOffer.subject || defaultRecipient.subject
    },
    editable_offer: editableOffer,
    content: {
      intro: editableOffer.intro,
      notes: editableOffer.notes,
      signature: editableOffer.signature
    },
    tables: {
      requested: requestedTable,
      inventory_alternative: {
        ...inventoryAlternative,
        enabled: inventoryEnabled
      }
    }
  };
}

function mergeEditableOffer(base, override) {
  return {
    ...base,
    ...override,
    inventory_alternative: {
      ...(base.inventory_alternative || {}),
      ...(override.inventory_alternative || {}),
      replacement: {
        ...(base.inventory_alternative?.replacement || {}),
        ...(override.inventory_alternative?.replacement || {})
      }
    }
  };
}

export function renderEditableOfferHtml(state) {
  const tables = [state.tables.requested];
  if (state.tables.inventory_alternative.enabled && state.tables.inventory_alternative.table) {
    tables.push(state.tables.inventory_alternative.table);
  }
  return buildEditedDraftHtml({
    intro: state.content.intro,
    tables,
    notes: state.content.notes,
    signature: state.content.signature
  });
}

export function checkEditableOfferConsistency(run, overrides = {}) {
  const state = buildEditableOfferState(run, overrides);
  const previewHtml = renderEditableOfferHtml(state);
  const mailHtml = renderEditableOfferHtml(state);
  const review = fingerprintFromState(state);
  const preview = fingerprintFromHtml(previewHtml, state);
  const mail = fingerprintFromHtml(mailHtml, state);
  const firstDifference = firstFingerprintDifference(review, preview, mail);

  return {
    ok: !firstDifference,
    runId: state.run_id,
    editable_offer: state.editable_offer,
    rules: inventoryAlternativeRuleSummary(state),
    review,
    preview,
    mail,
    firstDifference
  };
}

export function inventoryAlternativeRuleSummary(state) {
  return {
    suggested: state.tables.inventory_alternative.suggested,
    hideable: state.tables.inventory_alternative.hideable,
    ownerOverrideAllowed: state.tables.inventory_alternative.owner_override_allowed,
    replacementAllowed: state.tables.inventory_alternative.replacement_allowed,
    enabled: state.tables.inventory_alternative.enabled,
    activeSource: state.tables.inventory_alternative.active_source,
    replacementEnabled: state.editable_offer.inventory_alternative.replacement.enabled === true
  };
}

function normalizeInventoryReplacement(input) {
  if (!input || typeof input !== 'object') {
    return {
      enabled: false,
      inventory_sku: '',
      inventory_name: '',
      reason: ''
    };
  }
  return {
    enabled: input.enabled === true,
    inventory_sku: String(input.inventory_sku || '').trim(),
    inventory_name: String(input.inventory_name || '').trim(),
    reason: String(input.reason || '').trim()
  };
}

function resolveInventoryAlternative(run = {}) {
  const match = run.match_json || {};
  const hasInventoryMatch = match.hat_match === true || match.hasInventoryMatch === true;
  const table = hasInventoryMatch ? inventoryTableFromMatch(run) : null;
  const suggested = Boolean(hasInventoryMatch && table);
  return {
    suggested,
    hideable: suggested,
    owner_override_allowed: suggested,
    replacement_allowed: suggested,
    heading: suggested ? INVENTORY_HEADING : null,
    source: {
      top_lager_name: match.top_lager_name || match.topInventoryName || run.summary?.topInventoryName || null
    },
    table
  };
}

function resolveInventoryAlternativeForEditableOffer(run, editableOffer) {
  const original = resolveInventoryAlternative(run);
  const replacement = editableOffer.inventory_alternative.replacement;
  const enabled = original.suggested && editableOffer.inventory_alternative.enabled !== false;
  if (!enabled) {
    return {
      ...original,
      enabled: false,
      active_source: 'hidden',
      table: null
    };
  }
  if (replacement.enabled === true) {
    const replacementTable = inventoryReplacementTable(replacement, original.table);
    return {
      ...original,
      enabled: Boolean(replacementTable),
      active_source: 'replacement',
      replacement,
      heading: replacementTable ? INVENTORY_HEADING : null,
      table: replacementTable
    };
  }
  return {
    ...original,
    enabled: true,
    active_source: 'suggested'
  };
}

function inventoryTableFromMatch(run = {}) {
  const match = run.match_json || {};
  const rows = draftRowsFromPricing(match.kalkulation_lager || {});
  if (rows.length <= 3) return null;
  return {
    role: 'inventory_alternative',
    title: INVENTORY_HEADING,
    intro: `Passendes Lagerfahrzeug: ${match.top_lager_name || match.topInventoryName || run.summary?.topInventoryName || 'Lagerfahrzeug'}`,
    rows
  };
}

function inventoryReplacementTable(replacement, originalTable) {
  const product = findEduardProductByCode(replacement.inventory_sku);
  const rows = product
    ? draftRowsFromCatalogProduct(product, replacement)
    : draftRowsFromReplacementFallback(originalTable?.rows || [], replacement);
  if (!rows.length) return null;
  const displayName = replacementDisplayName(replacement);
  return {
    role: 'inventory_alternative',
    title: INVENTORY_HEADING,
    intro: [
      `Passendes Lagerfahrzeug: ${displayName}`,
      replacement.reason ? `Grund: ${replacement.reason}` : ''
    ].filter(Boolean).join(' - '),
    replacement: {
      enabled: true,
      inventory_sku: replacement.inventory_sku,
      inventory_name: replacement.inventory_name,
      reason: replacement.reason
    },
    rows
  };
}

function draftRowsFromCatalogProduct(product, replacement) {
  const uvpNet = Number((Number(product.grossPriceConfigurator || 0) / 1.2).toFixed(2));
  const offerNet = Number(product.netPriceDiscount3 || product.netPrice || uvpNet);
  const discountNet = uvpNet - offerNet;
  const productName = replacementDisplayName(replacement) || `${product.type} ${product.lxw} - ${product.grossWeightKg}kg (Art.Nr: ${product.productCode})`;
  return [
    {
      type: 'item',
      product: productName,
      uvp: formatMoney(uvpNet),
      discount: formatMoney(discountNet),
      offer: formatMoney(offerNet)
    },
    { product: 'Gesamt netto', uvp: formatMoney(uvpNet), discount: formatMoney(discountNet), offer: formatMoney(offerNet), type: 'total' },
    { product: '20% MwSt', uvp: formatMoney(uvpNet * 0.2), discount: formatMoney(discountNet * 0.2), offer: formatMoney(offerNet * 0.2), type: 'vat' },
    { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: formatMoney(uvpNet * 1.2), discount: formatMoney(discountNet * 1.2), offer: formatMoney(offerNet * 1.2), type: 'gross' }
  ];
}

function draftRowsFromReplacementFallback(rows, replacement) {
  if (!rows.length) return [];
  return rows.map((row, index) => {
    if (index !== 0 || row.type !== 'item') return row;
    return {
      ...row,
      product: replacementDisplayName(replacement) || row.product
    };
  });
}

function replacementDisplayName(replacement) {
  const name = replacement.inventory_name || '';
  const sku = replacement.inventory_sku || '';
  if (!name) return sku;
  if (!sku || name.includes(sku)) return name;
  return `${name} (Art.Nr: ${sku})`;
}

function draftRowsFromPricing(pricing = {}) {
  const positions = Array.isArray(pricing.positionen) ? pricing.positionen : [];
  const rows = positions.map((position) => {
    const uvpNet = Number(position.uvp_netto || 0);
    const offerNet = Number(position.angebot_netto || 0);
    return {
      type: 'item',
      product: position.produkt_name || 'Produkt',
      uvp: formatMoney(uvpNet),
      discount: formatMoney(uvpNet - offerNet),
      offer: formatMoney(offerNet)
    };
  });
  if (!rows.length) return rows;
  const uvpNet = Number(pricing.gesamt_uvp_netto || pricing.gesamt_uvp_brutto / 1.2 || 0);
  const offerNet = Number(pricing.gesamt_angebot_netto || pricing.gesamt_angebot_brutto / 1.2 || 0);
  const discountNet = Number(pricing.gesamt_rabatt_netto || pricing.gesamt_rabatt_brutto / 1.2 || (uvpNet - offerNet));
  rows.push(
    { product: 'Gesamt netto', uvp: formatMoney(uvpNet), discount: formatMoney(discountNet), offer: formatMoney(offerNet), type: 'total' },
    { product: '20% MwSt', uvp: formatMoney(uvpNet * 0.2), discount: formatMoney(discountNet * 0.2), offer: formatMoney(offerNet * 0.2), type: 'vat' },
    { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: formatMoney(uvpNet * 1.2), discount: formatMoney(discountNet * 1.2), offer: formatMoney(offerNet * 1.2), type: 'gross' }
  );
  return rows;
}

function draftRowsFromEditableRows(rows = []) {
  return rows.map((row) => ({
    type: row.type || 'item',
    product: row.product || '',
    uvp: formatMoney(parseMoney(row.uvpNet)),
    discount: formatMoney(parseMoney(row.discount)),
    offer: formatMoney(parseMoney(row.offerNet))
  }));
}

function fingerprintFromState(state) {
  const requestedRows = state.tables.requested.rows;
  const inventory = state.tables.inventory_alternative;
  const inventoryName = inventory.enabled
    ? inventory.active_source === 'replacement'
      ? inventory.replacement?.inventory_name || null
      : inventory.source?.top_lager_name || null
    : null;
  return {
    requestedModel: firstItemProduct(requestedRows),
    requestedTotalGross: grossOffer(requestedRows),
    inventoryEnabled: inventory.enabled,
    inventoryHeading: inventory.enabled ? inventory.heading : null,
    inventorySource: inventory.enabled ? inventory.active_source : null,
    inventory_name: inventoryName,
    inventorySku: inventory.enabled && inventory.active_source === 'replacement' ? inventory.replacement?.inventory_sku || null : null,
    inventoryModel: inventory.enabled ? firstItemProduct(inventory.table?.rows || []) : null,
    inventoryTotalGross: inventory.enabled ? grossOffer(inventory.table?.rows || []) : null,
    inventoryReplacementReason: inventory.enabled && inventory.active_source === 'replacement' ? inventory.replacement?.reason || null : null,
    tableCount: inventory.enabled ? 2 : 1,
    inventoryTableCount: inventory.enabled ? 1 : 0,
    originalInventoryStillVisible: false
  };
}

function fingerprintFromHtml(html, state) {
  const review = fingerprintFromState(state);
  const originalName = state.tables.inventory_alternative.source?.top_lager_name || null;
  const replacementActive = review.inventorySource === 'replacement';
  return {
    requestedModel: htmlContainsValue(html, review.requestedModel) ? review.requestedModel : null,
    requestedTotalGross: htmlContainsValue(html, review.requestedTotalGross) ? review.requestedTotalGross : null,
    inventoryEnabled: html.includes(INVENTORY_HEADING),
    inventoryHeading: html.includes(INVENTORY_HEADING) ? INVENTORY_HEADING : null,
    inventorySource: review.inventorySource,
    inventory_name: htmlContainsValue(html, review.inventory_name) ? review.inventory_name : null,
    inventorySku: htmlContainsValue(html, review.inventorySku) ? review.inventorySku : null,
    inventoryModel: htmlContainsValue(html, review.inventoryModel) ? review.inventoryModel : null,
    inventoryTotalGross: htmlContainsValue(html, review.inventoryTotalGross) ? review.inventoryTotalGross : null,
    inventoryReplacementReason: htmlContainsValue(html, review.inventoryReplacementReason) ? review.inventoryReplacementReason : null,
    tableCount: (html.match(/<table\b/gi) || []).length,
    inventoryTableCount: html.includes(INVENTORY_HEADING) ? 1 : 0,
    originalInventoryStillVisible: Boolean(replacementActive && originalName && originalName !== review.inventory_name && htmlContainsValue(html, originalName))
  };
}

function htmlContainsValue(html, value) {
  if (!value) return null;
  return html.includes(value) || html.includes(escapeHtml(value));
}

function firstFingerprintDifference(review, preview, mail) {
  for (const key of Object.keys(review)) {
    if (preview[key] !== review[key]) {
      return `preview.${key} != review.${key}${review.inventorySource === 'replacement' ? ' (Replacement-Fall)' : ''}`;
    }
    if (mail[key] !== review[key]) {
      return `mail.${key} != review.${key}${review.inventorySource === 'replacement' ? ' (Replacement-Fall)' : ''}`;
    }
  }
  return null;
}

function firstItemProduct(rows = []) {
  return rows.find((row) => row.type === 'item')?.product || null;
}

function grossOffer(rows = []) {
  return rows.find((row) => row.type === 'gross')?.offer || null;
}

function formatMoney(value) {
  return new Intl.NumberFormat('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseMoney(value) {
  const normalized = String(value || '')
    .replace(/[^\d,.]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  return Number.parseFloat(normalized) || 0;
}
