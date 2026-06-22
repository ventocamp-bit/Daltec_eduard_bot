import { parseCsvObjectsFromText } from '../adapters/local-data.js';
import { parseEuroNumber } from './format.js';

const HEADER_ALIASES = {
  sku: ['Art.-Nr.', 'Artikelnummer', 'Produktcode'],
  name: ['Art.-Bez.', 'Artikelbezeichnung', 'Bezeichnung', 'Typ'],
  stock: ['Lagermenge', 'verf. Lagermenge', 'Lager'],
  stockValue: ['Lagerwert', 'EK', 'Einkaufspreis', 'Bruttopreis (Konfigurator)'],
  length: ['Länge', 'Laenge'],
  width: ['Breite'],
  weight: ['hzGGew', 'hzG Gew', 'Gewicht', 'KG'],
  serial: ['Ser.-Nr. (int)', 'Ser.-Nr. (ext)', 'Seriennummer', 'FIN']
};

const REQUIRED_FIELDS = ['sku', 'name', 'stock', 'stockValue'];

export function validateInventoryCsv(content) {
  const errors = [];
  const warnings = [];
  const rows = parseCsvObjectsFromText(content || '');
  const headers = Object.keys(rows[0] || {});
  const resolved = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, findHeader(headers, aliases)])
  );

  if (rows.length === 0) {
    errors.push({
      code: 'csv_empty',
      message: 'Die CSV enthält keine Datenzeilen.'
    });
  }

  for (const field of REQUIRED_FIELDS) {
    if (!resolved[field]) {
      errors.push({
        code: `missing_${field}`,
        message: `Pflichtspalte fehlt: ${HEADER_ALIASES[field].join(' oder ')}`
      });
    }
  }

  if (!resolved.length) warnings.push({ code: 'missing_length', message: 'Längen-Spalte fehlt. Matching fällt auf den Produktnamen zurück.' });
  if (!resolved.width) warnings.push({ code: 'missing_width', message: 'Breiten-Spalte fehlt. Matching fällt auf den Produktnamen zurück.' });
  if (!resolved.weight) warnings.push({ code: 'missing_weight', message: 'Gewichts-Spalte fehlt. Matching wird unsicherer.' });

  const seenVehicle = new Map();
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const sku = cell(row, resolved.sku);
    const name = cell(row, resolved.name);
    const stock = cell(row, resolved.stock);
    const stockValue = cell(row, resolved.stockValue);
    const serial = cell(row, resolved.serial);

    if (!sku) {
      errors.push({ code: 'missing_sku_value', row: rowNumber, message: `Zeile ${rowNumber}: Art.-Nr. fehlt.` });
    } else {
      const normalizedSku = normalizeSku(sku);
      const vehicleKey = serial ? `${normalizedSku}:${normalizeSku(serial)}` : '';
      if (vehicleKey && seenVehicle.has(vehicleKey)) {
        errors.push({
          code: 'duplicate_vehicle',
          row: rowNumber,
          message: `Zeile ${rowNumber}: Art.-Nr. ${sku} mit Seriennummer ${serial} ist doppelt vorhanden (erste Zeile ${seenVehicle.get(vehicleKey)}).`
        });
      } else if (vehicleKey) {
        seenVehicle.set(vehicleKey, rowNumber);
      }
    }

    if (!name) {
      errors.push({ code: 'missing_name_value', row: rowNumber, message: `Zeile ${rowNumber}: Art.-Bez. fehlt.` });
    }

    const stockNumber = parseInteger(stock);
    if (stockNumber === null || stockNumber < 0) {
      errors.push({ code: 'invalid_stock', row: rowNumber, message: `Zeile ${rowNumber}: Lagermenge ist keine gültige Zahl.` });
    }

    const priceNumber = parseEuroNumber(stockValue);
    if (priceNumber <= 0) {
      errors.push({ code: 'invalid_stock_value', row: rowNumber, message: `Zeile ${rowNumber}: Lagerwert/Preis ist leer oder ungültig.` });
    }

    validateOptionalPositiveInteger(row, resolved.length, 'invalid_length', 'Länge', rowNumber, warnings);
    validateOptionalPositiveInteger(row, resolved.width, 'invalid_width', 'Breite', rowNumber, warnings);
    validateOptionalPositiveInteger(row, resolved.weight, 'invalid_weight', 'hzGGew/Gewicht', rowNumber, warnings);
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      rows: rows.length,
      columns: headers.length,
      headers,
      mappedHeaders: resolved
    }
  };
}

function findHeader(headers, aliases) {
  const normalizedHeaders = headers.map((header) => ({ header, key: normalizeHeader(header) }));
  for (const alias of aliases) {
    const wanted = normalizeHeader(alias);
    const exact = normalizedHeaders.find((entry) => entry.key === wanted);
    if (exact) return exact.header;
  }
  return '';
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function cell(row, header) {
  return header ? String(row[header] || '').trim() : '';
}

function parseInteger(value) {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function validateOptionalPositiveInteger(row, header, code, label, rowNumber, warnings) {
  if (!header) return;
  const value = cell(row, header);
  if (!value) return;
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0) {
    warnings.push({ code, row: rowNumber, message: `Zeile ${rowNumber}: ${label} ist nicht sauber lesbar.` });
  }
}
