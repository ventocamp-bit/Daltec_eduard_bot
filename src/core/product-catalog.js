import fs from 'node:fs';
import path from 'node:path';

import { parseEuroNumber } from './format.js';

const CATALOG_PATH = path.resolve('data/eduard-product-catalog.json');

let cachedCatalog;
let cachedLegacyRows;

export function loadEduardProductCatalog() {
  if (!cachedCatalog) {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    cachedCatalog = JSON.parse(raw);
  }
  return cachedCatalog;
}

export function loadEduardProductRows() {
  return loadEduardProductCatalog().products || [];
}

export function loadEduardLegacyPriceRows() {
  if (!cachedLegacyRows) {
    cachedLegacyRows = loadEduardProductRows().map(productToLegacyPriceRow);
  }
  return cachedLegacyRows;
}

export function findEduardProductByCode(code, products = loadEduardProductRows()) {
  const requested = cleanSku(code);
  if (!requested) return null;
  return products.find((product) => cleanSku(product.productCode) === requested) || null;
}

export function findEduardProductForLineItem(item, products = loadEduardProductRows()) {
  const codes = [
    item?.artikelnummer,
    item?.produktcode,
    ...(Array.isArray(item?.artikelnummern) ? item.artikelnummern : [])
  ];
  for (const code of codes) {
    const product = findEduardProductByCode(code, products);
    if (product) return product;
  }

  const name = String(item?.produkt_name_original || item?.produkt_name || '');
  const codeInName = name.match(/\b\d{4}-[0-9]-[A-Z0-9]{2,4}-\d{4}(?:-[A-Z])?\b/i)?.[0];
  return codeInName ? findEduardProductByCode(codeInName, products) : null;
}

export function productToLegacyPriceRow(product = {}) {
  return {
    Produktcode: product.productCode || '',
    LxW: product.lxw || '',
    Achse: String(product.axleCount || ''),
    Bremse: product.braked ? 'Ja' : 'Nein',
    Typ: product.type || '',
    KG: String(product.grossWeightKg || ''),
    Lfh: String(product.loadingHeightCm || ''),
    Reifen: product.tire || '',
    Aufbau: product.build || '',
    Rampe: product.ramp || 'n.a.',
    Bedienung: product.control || 'n.a.',
    'Bruttopreis (Konfigurator)': formatCatalogNumber(product.grossPriceConfigurator),
    Nettopreis: formatCatalogNumber(product.netPrice),
    'Nettopreis + 3% Rabatt': formatCatalogNumber(product.netPriceDiscount3)
  };
}

export function productToOfferPosition(product = {}) {
  return {
    produkt_name: `${product.type} ${product.lxw} - ${product.grossWeightKg}kg (Art.Nr: ${product.productCode})`,
    uvp_netto: Number((Number(product.grossPriceConfigurator || 0) / 1.2).toFixed(2)),
    kategorie: 'anhaenger',
    produktcode: product.productCode,
    product_family: product.family,
    use_case: product.useCase,
    length_mm: product.lengthMm,
    width_mm: product.widthMm,
    gross_weight_kg: product.grossWeightKg,
    braked: product.braked,
    has_ramps: product.hasRamps,
    ramp_type: product.ramp,
    control_type: product.control
  };
}

export function parseLegacyConfiguratorGross(row = {}) {
  return parseEuroNumber(row['Bruttopreis (Konfigurator)']);
}

function formatCatalogNumber(value) {
  return Number(value || 0).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  });
}

function cleanSku(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}
