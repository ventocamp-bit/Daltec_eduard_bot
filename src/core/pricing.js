import { parseEuroNumber } from './format.js';
import {
  findEduardProductForLineItem,
  loadEduardLegacyPriceRows,
  parseLegacyConfiguratorGross,
  productToOfferPosition
} from './product-catalog.js';

export function calculateInquiryOffer(inquiry, preisliste = [], settings = {}) {
  const masterPriceRows = preisliste.length ? preisliste : loadEduardLegacyPriceRows();
  let serviceSummeNetto = 0;
  const positionen = [];
  const prices = (inquiry.line_items || []).map((item) => Number(item.preis_mail_brutto_num) || 0);
  const maxPrice = Math.max(0, ...prices);

  for (const item of inquiry.line_items || []) {
    let cleanName = String(item.produkt_name_original || '').replace(/\*/g, '').trim();
    let nameLower = cleanName.toLowerCase();
    let preisNetto = Number(item.preis_mail_brutto_num) || 0;

    const catalogProduct = findEduardProductForLineItem(item);
    if (catalogProduct && (item.is_sku_not_found === true || preisNetto === 0)) {
      const catalogPosition = productToOfferPosition(catalogProduct);
      preisNetto = catalogPosition.uvp_netto;
      cleanName = catalogPosition.produkt_name;
      nameLower = cleanName.toLowerCase();
    } else if (item.is_sku_not_found === true) {
      const master = masterPriceRows.find((entry) => entry.Produktcode && String(entry.Produktcode).includes(cleanName));
      if (master) {
        preisNetto = parseLegacyConfiguratorGross(master) / 1.2;
        cleanName = `${master.Typ} ${master.LxW} - ${master.KG}kg (Art.Nr: ${master.Produktcode})`;
        nameLower = cleanName.toLowerCase();
      }
    }

    if (preisNetto === 0 || preisNetto > 50000) continue;
    const istSummenzeile =
      /^preis$|^gesamt$|gesamtpreis|^total$/.test(nameLower) ||
      nameLower === '' ||
      cleanName.length < 2 ||
      preisNetto === maxPrice && /^preis$|^gesamt$|gesamtpreis|^total$/.test(nameLower);
    if (istSummenzeile || /telefonnummer/.test(nameLower) || /gesendet|datum/.test(nameLower)) continue;

    if (/coc|typisierung|service|bereitstellung/.test(nameLower)) {
      serviceSummeNetto += preisNetto;
    } else {
      const catalogPosition = catalogProduct ? productToOfferPosition(catalogProduct) : null;
      const catalogMeta = catalogPosition ? {
        produktcode: catalogPosition.produktcode,
        product_family: catalogPosition.product_family,
        use_case: catalogPosition.use_case,
        length_mm: catalogPosition.length_mm,
        width_mm: catalogPosition.width_mm,
        gross_weight_kg: catalogPosition.gross_weight_kg,
        braked: catalogPosition.braked,
        has_ramps: catalogPosition.has_ramps,
        ramp_type: catalogPosition.ramp_type,
        control_type: catalogPosition.control_type
      } : {};
      positionen.push({
        produkt_name: catalogPosition?.produkt_name || cleanName,
        uvp_netto: preisNetto,
        kategorie: catalogPosition?.kategorie || resolveProductCategory(cleanName, settings.pricing),
        ...catalogMeta
      });
    }
  }

  if (positionen.length === 0 && serviceSummeNetto > 0) {
    positionen.push({
      produkt_name: 'Dienstleistung (inkl. COC & Typisierung)',
      uvp_netto: serviceSummeNetto,
      kategorie: 'zubehoer'
    });
  } else if (positionen.length > 0) {
    positionen[0].uvp_netto += serviceSummeNetto;
    if (!positionen[0].produkt_name.includes('(inkl. COC & Typisierung)')) {
      positionen[0].produkt_name += ' (inkl. COC & Typisierung)';
    }
  }

  return {
    ...inquiry,
    kalkulation_anfrage: calculate(positionen, settings.pricing)
  };
}

export function calculate(items, pricing = {}) {
  const offerFactor = Number(pricing.offerFactor ?? 0.87);
  const roundTo = Number(pricing.roundTo ?? 10);
  const vatRate = Number(pricing.vatRate ?? 0.2);
  const warnings = [];
  const pricedItems = items.map((item) => {
    const resolvedRule = resolveAppliedPricingRule(item, pricing, offerFactor);
    const itemOfferFactor = resolvedRule.offerFactor;
    if (!Number.isFinite(Number(item.uvp_netto)) || Number(item.uvp_netto) <= 0) {
      warnings.push({ code: 'invalid_input_price', product: item.produkt_name });
    }
    return {
      ...item,
      offerFactor: itemOfferFactor,
      target_angebot_netto: item.uvp_netto * itemOfferFactor,
      applied_pricing_rule: resolvedRule.rule
    };
  });
  const totalNettoUvp = pricedItems.reduce((sum, item) => sum + item.uvp_netto, 0);
  const totalBruttoUvp = totalNettoUvp * (1 + vatRate);
  const targetBrutto = pricedItems.reduce((sum, item) => sum + item.target_angebot_netto * (1 + vatRate), 0);
  const angebotBrutto = Math.ceil(targetBrutto / roundTo) * roundTo;
  const angebotNetto = angebotBrutto / (1 + vatRate);
  const targetNetto = pricedItems.reduce((sum, item) => sum + item.target_angebot_netto, 0);

  return {
    price_source: 'eduard_mail',
    vat_rate: vatRate,
    rounding_step: roundTo,
    warnings,
    applied_rules: pricedItems.map((item) => item.applied_pricing_rule),
    final_net: Number(angebotNetto.toFixed(2)),
    final_gross: Number(angebotBrutto.toFixed(2)),
    gesamt_uvp_netto: Number(totalNettoUvp.toFixed(2)),
    gesamt_uvp_brutto: Number(totalBruttoUvp.toFixed(2)),
    gesamt_rabatt_brutto: Number((totalBruttoUvp - angebotBrutto).toFixed(2)),
    gesamt_angebot_brutto: Number(angebotBrutto.toFixed(2)),
    gesamt_angebot_netto: Number(angebotNetto.toFixed(2)),
    mwst_betrag: Number((angebotNetto * vatRate).toFixed(2)),
    positionen: pricedItems.map((item) => {
      const itemAngebotNetto = targetNetto > 0
        ? angebotNetto * (item.target_angebot_netto / targetNetto)
        : 0;
      const rabattNetto = item.uvp_netto - itemAngebotNetto;
      return {
        ...item,
        produkt_name: item.produkt_name,
        kategorie: item.kategorie || 'zubehoer',
        input_price_netto: Number(item.uvp_netto.toFixed(2)),
        price_source: 'eduard_mail',
        discount_rule_id: item.applied_pricing_rule.id,
        discount_type: item.applied_pricing_rule.type,
        discount_percent: item.applied_pricing_rule.percent,
        uvp_netto: Number(item.uvp_netto.toFixed(2)),
        rabatt_netto: Number(rabattNetto.toFixed(2)),
        angebot_netto: Number(itemAngebotNetto.toFixed(2))
      };
    })
  };
}

export function resolveAppliedPricingRule(item, pricing = {}, fallbackFactor = 0.87) {
  const rule = resolvePricingRule(item, pricing, ['uvp_discount']);
  if (rule) {
    const percent = Number(rule.percent || 0);
    return {
      offerFactor: 1 - percent / 100,
      rule: {
        id: `rule:${rule.index}`,
        type: 'uvp_discount',
        source: rule.source || 'uvp_discount',
        match: rule.match || '',
        category: rule.category || 'alle',
        percent
      }
    };
  }

  const category = item?.kategorie || 'zubehoer';
  const categoryDiscount = pricing.categoryDiscounts?.[category];
  if (categoryDiscount !== undefined && categoryDiscount !== '') {
    const percent = Number(categoryDiscount);
    return {
      offerFactor: 1 - percent / 100,
      rule: {
        id: `category:${category}`,
        type: 'category_discount',
        source: 'category_discount',
        match: category,
        category,
        percent
      }
    };
  }

  const percent = Number((1 - Number(fallbackFactor)) * 100);
  return {
    offerFactor: Number(fallbackFactor),
    rule: {
      id: 'default:offerFactor',
      type: 'default_discount',
      source: 'offerFactor',
      match: '',
      category,
      percent: Number(percent.toFixed(2))
    }
  };
}

export function resolveOfferFactor(item, pricing = {}, fallbackFactor = 0.87) {
  const rule = resolvePricingRule(item, pricing, ['uvp_discount']);
  if (rule) return 1 - Number(rule.percent || 0) / 100;

  const category = item?.kategorie || 'zubehoer';
  const categoryDiscount = pricing.categoryDiscounts?.[category];
  if (categoryDiscount !== undefined && categoryDiscount !== '') {
    return 1 - Number(categoryDiscount) / 100;
  }
  return Number(fallbackFactor);
}

export function resolvePricingRule(item, pricing = {}, allowedSources = []) {
  const rules = Array.isArray(pricing.rules) ? pricing.rules : [];
  const allowed = new Set(allowedSources);
  const candidates = rules
    .filter((rule) => rule && rule.enabled !== false)
    .filter((rule) => allowed.size === 0 || allowed.has(rule.source))
    .filter((rule) => matchesRule(item, rule))
    .map((rule, index) => ({
      ...rule,
      index,
      specificity: String(rule.match || '').trim().length + (rule.category ? 100 : 0)
    }));
  candidates.sort((a, b) => b.specificity - a.specificity || a.index - b.index);
  return candidates[0] || null;
}

function matchesRule(item, rule) {
  const itemCategory = item?.kategorie || '';
  if (rule.category && rule.category !== 'alle' && rule.category !== itemCategory) return false;

  const needle = normalizeRuleText(rule.match);
  if (!needle) return true;

  const haystack = normalizeRuleText([
    item?.produkt_name,
    item?.produkt_name_original,
    item?.art_nr,
    item?.typ,
    item?.lager_name
  ].filter(Boolean).join(' '));
  return haystack.includes(needle);
}

function normalizeRuleText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

export function resolveProductCategory(name, pricing = {}) {
  const group = resolveProductGroup(name, pricing);
  if (group?.id) return group.id;
  return isTrailerPosition(name) ? 'anhaenger' : 'zubehoer';
}

function resolveProductGroup(name, pricing = {}) {
  const groups = Array.isArray(pricing.productGroups) ? pricing.productGroups : [];
  const candidates = groups
    .filter((group) => group && group.enabled !== false && group.id)
    .filter((group) => matchesProductGroup(name, group))
    .map((group, index) => ({
      ...group,
      index,
      specificity: normalizeRuleText(group.match).length
    }));
  candidates.sort((a, b) => b.specificity - a.specificity || a.index - b.index);
  return candidates[0] || null;
}

function matchesProductGroup(name, group) {
  const haystack = normalizeRuleText(name);
  const needles = String(group.match || group.label || group.id || '')
    .split(/[,\n;]/)
    .map((part) => normalizeRuleText(part))
    .filter(Boolean);
  return needles.some((needle) => haystack.includes(needle));
}

function isTrailerPosition(name) {
  const value = String(name || '').toLowerCase();
  if (/flatbed/.test(value)) return true;
  return /anhänger|anhaenger|hochlader|kipper|dreiseiten|rückwärts|rueckwaerts|ruckwaerts|autotransporter|multitransporter|fahrzeugtransporter|cargo/.test(value);
}
