import crypto from 'node:crypto';

export function buildLeadFingerprint(tenantId, input) {
  const raw = [
    input.subject,
    input.from_email,
    input.from,
    input.to_email,
    input.to,
    input.raw_text,
    input.text,
    htmlToText(input.raw_html || input.html)
  ].filter(Boolean).join('\n');
  const normalized = normalizeFingerprintText(raw);
  const configuratorId = firstMatch(normalized, /configurator\/([a-z0-9-]{24,})/i);
  const customerEmail = firstMatch(normalized, /e-?mail-adresse[^a-z0-9@]{0,30}([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
    || firstMatch(normalized, /kunden e-?mail kopieren:\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  const articleNumbers = [...normalized.matchAll(/\b\d{4}-[0-9]-[a-z0-9]{2,4}-\d{4}(?:-[a-z])?\b/gi)]
    .map((match) => match[0].toUpperCase())
    .sort();
  const pricedProducts = extractPricedProducts(normalized);

  if (configuratorId) return `${tenantId}:configurator:${configuratorId}`;
  if (customerEmail && articleNumbers.length) return `${tenantId}:customer-sku:${customerEmail}:${articleNumbers.join(',')}`;
  if (customerEmail && pricedProducts.length) {
    const signature = crypto.createHash('sha256').update(pricedProducts.join('|')).digest('hex').slice(0, 24);
    return `${tenantId}:customer-offer:${customerEmail}:${signature}`;
  }
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
