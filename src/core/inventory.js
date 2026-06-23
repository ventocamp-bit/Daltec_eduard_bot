import { parseEuroNumber } from './format.js';
import { loadEduardLegacyPriceRows } from './product-catalog.js';
import { resolveOfferFactor, resolvePricingRule } from './pricing.js';

const TYP_KOMPATIBEL = {
  hochlader: ['hochlader'],
  rueckwaertskipper: ['rueckwaertskipper'],
  dreiseitenkipper: ['dreiseitenkipper'],
  autotransporter: ['autotransporter']
};

function cleanString(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[\s\-_]/g, '');
}

function cleanSku(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getRequestedSkus(item) {
  return [
    item.artikelnummer,
    item.produktcode,
    ...(Array.isArray(item.artikelnummern) ? item.artikelnummern : [])
  ].filter(Boolean).map(cleanSku).filter(Boolean);
}

export function getTrailerType(name) {
  const normalized = cleanString(name);
  if (normalized.includes('dreiseiten') || normalized.includes('3seiten') || (normalized.includes('3') && normalized.includes('seiten'))) {
    return 'dreiseitenkipper';
  }
  if (normalized.includes('ruckwarts') || normalized.includes('rueckwarts') || normalized.includes('heckkipper')) {
    return 'rueckwaertskipper';
  }
  if (normalized.includes('kipper') && !normalized.includes('dreiseiten') && !normalized.includes('3seiten')) {
    return 'rueckwaertskipper';
  }
  if (normalized.includes('autotransporter')) return 'autotransporter';
  if (normalized.includes('hochlader') || normalized.includes('cargo')) return 'hochlader';
  if (normalized.includes('mitrampen') && !normalized.includes('kipper')) return 'hochlader';
  return 'unbekannt';
}

function parseDimensionsFromName(name) {
  const match = String(name || '').match(/(\d{3,4})x(\d{3,4})/);
  if (!match) return { laenge: 0, breite: 0 };
  return {
    laenge: Number(match[1]) * 10,
    breite: Number(match[2]) * 10
  };
}

function parseSearchDimensions(name) {
  const compact = String(name || '').toLowerCase().replace(/\s+/g, '');
  const exact = compact.match(/(\d{3,4})x(\d{3,4})/);
  if (exact) {
    const laenge = Number(exact[1]);
    const breite = Number(exact[2]);
    return {
      sucheLaenge: laenge < 1000 ? laenge * 10 : laenge,
      sucheBreite: breite < 1000 ? breite * 10 : breite
    };
  }

  const code = String(name || '').match(/\b(\d{2})(\d{2})\b/);
  if (!code) return { sucheLaenge: 0, sucheBreite: 0 };
  return {
    sucheLaenge: Number(code[1]) * 100,
    sucheBreite: Number(code[2]) * 100
  };
}

function parseSearchWeight(name) {
  const compact = String(name || '').toLowerCase().replace(/\s+/g, '');
  const weight = compact.match(/(\d{3,4})kg/);
  if (weight) return Number(weight[1]);
  const code = String(name || '').match(/-(\d{2,3})\d{2}-/);
  return code ? Number(code[1]) * 100 : 0;
}

function matchConfidence(score) {
  if (score >= 2000) return 'high';
  if (score >= 1000) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function buildMatchExplanation({
  anfrageTyp,
  sucheLaenge,
  sucheBreite,
  sucheGewicht,
  requestedSkus,
  lagerArtikel,
  lagerTyp,
  lagerSku,
  skuMatch,
  lLaenge,
  lBreite,
  lGewicht,
  menge,
  score
}) {
  const reasons = [];
  const warnings = [];

  if (skuMatch) {
    reasons.push({ code: 'sku_match', message: 'Artikelnummer stimmt mit der Lagerzeile überein.' });
  }
  if (!skuMatch && TYP_KOMPATIBEL[anfrageTyp]?.includes(lagerTyp)) {
    reasons.push({ code: 'type_match', message: `Angefragter Typ ${anfrageTyp} passt zu Lager-Typ ${lagerTyp}.` });
  }
  if (sucheLaenge > 0 && lLaenge > 0) {
    const diff = Math.abs(lLaenge - sucheLaenge);
    if (diff === 0) reasons.push({ code: 'length_exact', message: 'Länge passt exakt.' });
    else if (diff <= 100) reasons.push({ code: 'length_close', message: `Länge weicht um ${diff} mm ab.` });
    else warnings.push({ code: 'length_mismatch', message: `Länge weicht um ${diff} mm ab.` });
  } else {
    warnings.push({ code: 'length_missing', message: 'Länge konnte nicht auf beiden Seiten sicher verglichen werden.' });
  }
  if (sucheBreite > 0 && lBreite > 0) {
    const diff = Math.abs(lBreite - sucheBreite);
    if (diff === 0) reasons.push({ code: 'width_exact', message: 'Breite passt exakt.' });
    else if (diff <= 200) reasons.push({ code: 'width_close', message: `Breite weicht um ${diff} mm ab.` });
    else warnings.push({ code: 'width_mismatch', message: `Breite weicht um ${diff} mm ab.` });
  } else {
    warnings.push({ code: 'width_missing', message: 'Breite konnte nicht auf beiden Seiten sicher verglichen werden.' });
  }
  if (sucheGewicht > 0 && lGewicht > 0) {
    const diff = lGewicht - sucheGewicht;
    if (diff === 0) reasons.push({ code: 'weight_exact', message: 'Gewicht passt exakt.' });
    else if (diff > 0 && diff <= 500) reasons.push({ code: 'weight_higher_close', message: `Lagerfahrzeug hat ${diff} kg mehr hzGGew.` });
    else warnings.push({ code: 'weight_mismatch', message: `Gewicht weicht um ${Math.abs(diff)} kg ab.` });
  } else {
    warnings.push({ code: 'weight_missing', message: 'Gewicht konnte nicht auf beiden Seiten sicher verglichen werden.' });
  }
  if (!skuMatch && requestedSkus.length > 0 && lagerSku) {
    warnings.push({ code: 'sku_not_exact', message: 'Artikelnummer ist kein exakter Treffer.' });
  }
  if (matchConfidence(score) === 'low') {
    warnings.push({ code: 'low_confidence', message: 'Match ist schwach und muss manuell geprüft werden.' });
  }

  return {
    requested_type: anfrageTyp,
    requested_length: sucheLaenge || null,
    requested_width: sucheBreite || null,
    requested_weight: sucheGewicht || null,
    requested_skus: requestedSkus,
    matched_item: lagerArtikel['Art.-Bez.'] || null,
    matched_sku: lagerArtikel['Art.-Nr.'] || lagerArtikel.Produktcode || null,
    matched_type: lagerTyp,
    matched_length: lLaenge || null,
    matched_width: lBreite || null,
    matched_weight: lGewicht || null,
    stock_qty: menge,
    score,
    confidence: matchConfidence(score),
    reasons,
    warnings
  };
}

export function matchInventory(input, lagerBestand = [], preisliste = [], settings = {}) {
  const masterPriceRows = preisliste.length ? preisliste : loadEduardLegacyPriceRows();
  const alleErgebnisse = [];

  for (const rawItem of input.line_items || []) {
    const anfrageName = String(rawItem.produkt_name_original || '').replace(/\*/g, '').trim();
    const anfrageTyp = getTrailerType(anfrageName);
    if (anfrageTyp === 'unbekannt') continue;

    const erlaubteTypen = TYP_KOMPATIBEL[anfrageTyp] || [anfrageTyp];
    const { sucheLaenge, sucheBreite } = parseSearchDimensions(anfrageName);
    const sucheGewicht = parseSearchWeight(anfrageName);
    const requestedSkus = getRequestedSkus(rawItem);
    const bewertetesLager = [];

    for (const lagerArtikel of lagerBestand) {
      const menge = Number.parseInt(lagerArtikel['verf. Lagermenge'] || lagerArtikel.Lagermenge || lagerArtikel.Lager || '0', 10);
      if (menge < 1) continue;

      const lagerTyp = getTrailerType(lagerArtikel['Art.-Bez.']);
      const lagerSku = cleanSku(lagerArtikel['Art.-Nr.'] || lagerArtikel.Produktcode);
      const skuMatch = requestedSkus.some((sku) => sku === lagerSku);
      if (!skuMatch && !erlaubteTypen.includes(lagerTyp)) continue;

      const masse = parseDimensionsFromName(lagerArtikel['Art.-Bez.']);
      const lLaenge = Number.parseInt(lagerArtikel['Länge'] || lagerArtikel.Laenge || '', 10) || masse.laenge || 0;
      const lBreite = Number.parseInt(lagerArtikel.Breite || '', 10) || masse.breite || 0;
      const lGewicht = Number.parseInt(lagerArtikel.hzGGew || '', 10) || 0;

      let score = 0;
      if (skuMatch) score += 5000;
      if (lLaenge > 0 && sucheLaenge > 0) {
        if (lLaenge === sucheLaenge) score += 1000;
        else if (Math.abs(lLaenge - sucheLaenge) <= 100) score += 500;
      }
      if (lBreite > 0 && sucheBreite > 0) {
        if (lBreite === sucheBreite) score += 800;
        else if (Math.abs(lBreite - sucheBreite) <= 100) score += 400;
        else if (Math.abs(lBreite - sucheBreite) <= 200) score += 250;
      }
      if (lGewicht > 0 && sucheGewicht > 0) {
        if (lGewicht === sucheGewicht) score += 300;
        else if (lGewicht > sucheGewicht && lGewicht - sucheGewicht <= 500) score += 250;
      }

      if (score > 0) {
        bewertetesLager.push({
          ...lagerArtikel,
          score,
          _match: buildMatchExplanation({
            anfrageTyp,
            sucheLaenge,
            sucheBreite,
            sucheGewicht,
            requestedSkus,
            lagerArtikel,
            lagerTyp,
            lagerSku,
            skuMatch,
            lLaenge,
            lBreite,
            lGewicht,
            menge,
            score
          })
        });
      }
    }

    const topMatches = bewertetesLager.sort((a, b) => b.score - a.score).slice(0, 1);
      alleErgebnisse.push({
      angefragt: anfrageName,
      anzahl_matches: topMatches.length,
      top_upsell: topMatches[0] || null,
      kalkulation_lager: topMatches[0] ? calculateInventoryOffer(topMatches[0], masterPriceRows, settings.pricing) : null
    });
  }

  const siegerMatch = alleErgebnisse.find((entry) => entry.anzahl_matches > 0 && entry.kalkulation_lager !== null);

  return {
    ...input,
    upsell_daten: alleErgebnisse,
    kalkulation_lager: siegerMatch?.kalkulation_lager ?? null,
    hat_match: Boolean(siegerMatch),
    top_lager_name: siegerMatch?.top_upsell?.['Art.-Bez.'] ?? null
  };
}

function calculateInventoryOffer(top, preisliste, pricing = {}) {
  const itemForRules = {
    kategorie: 'anhaenger',
    produkt_name: top['Art.-Bez.'],
    lager_name: top['Art.-Bez.'],
    art_nr: top['Art.-Nr.'],
    typ: getTrailerType(top['Art.-Bez.'])
  };
  const ekRule = resolvePricingRule(itemForRules, pricing, ['ek_markup']);
  const offerFactor = ekRule ? 1 : resolveOfferFactor(itemForRules, pricing, Number(pricing.offerFactor ?? 0.87));
  const roundTo = Number(pricing.roundTo ?? 10);
  const vatRate = Number(pricing.vatRate ?? 0.2);
  const fallbackMarkup = pricing.inventoryFallbackMarkupPercent !== undefined && pricing.inventoryFallbackMarkupPercent !== ''
    ? 1 + Number(pricing.inventoryFallbackMarkupPercent) / 100
    : Number(pricing.inventoryFallbackMarkup ?? 1.0);
  const topLagerCode = cleanString(top['Art.-Nr.']);
  let uvpNetto = 0;
  let produktNameLager = '';

  const master = preisliste.find((entry) => {
    const code = cleanString(entry.Produktcode);
    return code && (code.includes(topLagerCode) || topLagerCode.includes(code));
  });

  if (ekRule) {
    uvpNetto = parseEuroNumber(top.Lagerwert) * (1 + Number(ekRule.percent || 0) / 100);
    produktNameLager = `${top['Art.-Bez.']} (Art.Nr: ${top['Art.-Nr.']})`;
  } else if (master) {
    uvpNetto = parseEuroNumber(master['Bruttopreis (Konfigurator)']) / 1.2;
    produktNameLager = `${master.Typ} ${master.LxW} - ${master.KG}kg (Art.Nr: ${master.Produktcode})`;
  } else {
    uvpNetto = parseEuroNumber(top.Lagerwert) * fallbackMarkup;
    produktNameLager = `${top['Art.-Bez.']} (Art.Nr: ${top['Art.-Nr.']})`;
  }

  if (uvpNetto <= 0) return null;

  const bruttoUvp = Math.round(uvpNetto * (1 + vatRate) * 100) / 100;
  const angebotBrutto = Math.ceil((bruttoUvp * offerFactor) / roundTo) * roundTo;
  const angebotNetto = angebotBrutto / (1 + vatRate);
  const rabattBrutto = Number((bruttoUvp - angebotBrutto).toFixed(2));
  const warnings = [];
  if (rabattBrutto < 0) {
    warnings.push({
      code: 'negative_discount',
      message: 'Lagerangebot liegt über der Vergleichs-UVP. Bitte Darstellung und Preis prüfen.'
    });
  }
  const appliedRule = ekRule ? {
    id: `rule:${ekRule.index}`,
    type: 'ek_markup',
    source: 'ek_markup',
    match: ekRule.match || '',
    category: ekRule.category || 'alle',
    percent: Number(ekRule.percent || 0)
  } : {
    id: master ? 'inventory:master_price_list' : 'inventory:fallback_markup',
    type: master ? 'master_price_list' : 'fallback_markup',
    source: master ? 'Bruttopreis (Konfigurator)' : 'Lagerwert',
    match: top['Art.-Nr.'] || '',
    category: 'anhaenger',
    percent: ekRule ? Number(ekRule.percent || 0) : Number(((fallbackMarkup - 1) * 100).toFixed(2))
  };

  return {
    price_source: ekRule ? 'lagerwert_ek_markup' : (master ? 'master_price_list' : 'lagerwert_fallback_markup'),
    vat_rate: vatRate,
    rounding_step: roundTo,
    warnings,
    applied_rules: [appliedRule],
    final_net: Number(angebotNetto.toFixed(2)),
    final_gross: Number(angebotBrutto.toFixed(2)),
    gesamt_uvp_brutto: bruttoUvp,
    gesamt_angebot_brutto: Number(angebotBrutto.toFixed(2)),
    gesamt_rabatt_brutto: rabattBrutto,
    positionen: [
      {
                        produkt_name: produktNameLager,
                        kategorie: 'anhaenger',
                        input_price_netto: Number(uvpNetto.toFixed(2)),
                        price_source: ekRule ? 'Lagerwert' : (master ? 'Bruttopreis (Konfigurator)' : 'Lagerwert'),
                        discount_rule_id: appliedRule.id,
                        discount_type: appliedRule.type,
                        discount_percent: appliedRule.percent,
                        uvp_netto: Number(uvpNetto.toFixed(2)),
        rabatt_netto: Number((uvpNetto - angebotNetto).toFixed(2)),
        angebot_netto: Number(angebotNetto.toFixed(2))
      }
    ]
  };
}
