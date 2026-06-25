import crypto from 'node:crypto';

export function buildLeadFingerprint(tenantId, input) {
  return '';
}

function extractPricedProducts(value) {
  const matches = [...String(value || '').matchAll(/\b(\d{4}\s+-[a-z0-9-]+[^\n]{8,180}?)\s+(?:€|\?|eur)?\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2}))/gi)];
  return matches
    .map((match) => `${normalizeProductText(match[1])}:${normalizePrice(match[2])}`)
    .filter((signature) => signature.length > 12)
    .sort();
}

function normalizeProductText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9äöüß., -]+/gi, '')
    .trim()
    .toLowerCase();
}

function normalizePrice(value) {
  return String(value || '').replace(/\./g, '').replace(',', '.');
}

function firstMatch(value, regex) {
  const match = String(value || '').match(regex);
  return match ? match[1].toLowerCase() : '';
}

function normalizeFingerprintText(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

function htmlToText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}
