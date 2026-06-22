import { parseEuroNumber, stripHtml } from './format.js';

const STOP_LABELS = /^(Preis|MwSt|Preis inkl\. MwSt|Gesamt|Fragen|Bemerkungen|Konfiguration|Cena|DPH|Cena vč\. DPH|Nastavení|Otázky\/Připomínky\?)$/i;

function extractTableValue(html, label) {
  const regex = new RegExp(
    `<td[^>]*>\\s*<strong[^>]*>\\s*${label}\\s*<\\/strong>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
    'i'
  );
  const match = String(html || '').match(regex);
  return match ? stripHtml(match[1]) : '';
}

function extractPlainValue(text, label) {
  const regex = new RegExp(`${label}\\s*(?:\\n|\\r\\n|\\s{2,})([^\\n\\r]+)`, 'i');
  const match = String(text || '').match(regex);
  return match ? match[1].trim() : '';
}

function extractAnyValue(html, text, labels) {
  for (const label of labels) {
    const value = extractTableValue(html, label) || extractPlainValue(text, label);
    if (value) return value;
  }
  return '';
}

export function extractInquiry(raw = {}) {
  const html = raw.html || raw.bodyHtml || '';
  const text = raw.text || raw.bodyText || '';
  const articleNumbers = extractArticleNumbers(text || stripHtml(html));

  const vorname = extractAnyValue(html, text, ['Vorname', 'Jméno']) || 'Kunde';
  const nachname = extractAnyValue(html, text, ['Nachname', 'Příjmení']) || 'Unbekannt';
  const adresse = extractAnyValue(html, text, ['Adresse', 'Adresa']) || '';
  const telefon = extractAnyValue(html, text, ['Telefonnummer', 'Telefonní číslo']) || '';

  const emailRaw = extractAnyValue(html, text, ['E-mail-Adresse', 'Emailová adresa']) || '';
  const emailMatch = emailRaw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);

  const lineItems = [];
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  let rowMatch;
  let htmlItemsFound = false;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[0];
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!cells || cells.length !== 2) continue;

    const label = stripHtml(cells[0]);
    const value = stripHtml(cells[1]);
    if (!label || !value || STOP_LABELS.test(label)) continue;

    const priceMatch = value.match(/(€|EUR|\?)\s*([\d.\s]+,\d{2})/i);
    if (!priceMatch) continue;

    const price = parseEuroNumber(priceMatch[2].replace(/\s+/g, ''));
    if (price > 50000) continue;

    lineItems.push({ produkt_name_original: label, preis_mail_brutto_num: price });
    htmlItemsFound = true;
  }

  if (!htmlItemsFound) {
    const lines = String(text || '').split('\n');
    const stopIndex = lines.findIndex((line) => /(Artikelnummern|Kódy položek|Angefragter Anhänger)/i.test(line));
    const searchLines = stopIndex !== -1 ? lines.slice(0, stopIndex) : lines;

    for (let index = 0; index < searchLines.length; index += 1) {
      const cleanLine = searchLines[index].trim();
      if (!cleanLine || STOP_LABELS.test(cleanLine)) continue;

      const sameLinePrice = cleanLine.match(/^(.+?)\s+(€|EUR|\?|Kč)\s*([\d.\s]+,\d{2})\s*$/i);
      if (sameLinePrice) {
        const product = sameLinePrice[1].trim();
        if (STOP_LABELS.test(product)) continue;
        if (sameLinePrice[2].toLowerCase() === 'kč') {
          lineItems.push({
            produkt_name_original: product,
            preis_mail_brutto_num: 0,
            unsupported_currency: 'CZK',
            raw_price: `${sameLinePrice[2]} ${sameLinePrice[3]}`
          });
          continue;
        }
        const price = parseEuroNumber(sameLinePrice[3].replace(/\s+/g, ''));
        if (price > 50000) continue;
        lineItems.push({ produkt_name_original: product, preis_mail_brutto_num: price });
        continue;
      }

      const nextLine = (searchLines[index + 1] || '').trim();
      const nextLineCzkPrice = nextLine.match(/^(Kč)\s*([\d.\s]+,\d{2})\s*$/i);
      if (!nextLineCzkPrice || STOP_LABELS.test(cleanLine)) continue;
      lineItems.push({
        produkt_name_original: cleanLine,
        preis_mail_brutto_num: 0,
        unsupported_currency: 'CZK',
        raw_price: `${nextLineCzkPrice[1]} ${nextLineCzkPrice[2]}`
      });
    }
  }

  attachArticleNumbers(lineItems, articleNumbers);
  if (lineItems.length === 0 && articleNumbers.length && /SKU NOT FOUND/i.test(text || stripHtml(html))) {
    lineItems.push({
      produkt_name_original: articleNumbers[0],
      preis_mail_brutto_num: 0,
      is_sku_not_found: true,
      artikelnummern: articleNumbers,
      artikelnummer: articleNumbers[0]
    });
  }

  return {
    kunde_vorname: vorname,
    kunde_nachname: nachname,
    kunde_email: emailMatch ? emailMatch[1] : 'keine@email.com',
    kunde_adresse: adresse,
    kunde_telefon: telefon,
    line_items: lineItems
  };
}

function extractArticleNumbers(text) {
  const value = String(text || '');
  const markerIndex = value.search(/(Artikelnummern[\s\S]{0,80}Zubeh|Kódy položek[\s\S]{0,80}příslušenství|Angefragter Anhänger[\s\S]{0,80}Artikelcodes)/i);
  const searchArea = markerIndex === -1 ? value : value.slice(markerIndex);
  const matches = searchArea.match(/\b\d{4}-[0-9]-[A-Z0-9]{2,4}-\d{4}(?:-[A-Z])?\b/gi) || [];
  return [...new Set(matches.map((match) => match.trim()))];
}

function attachArticleNumbers(lineItems, articleNumbers) {
  if (!articleNumbers.length || !lineItems.length) return;
  const trailerIndex = lineItems.findIndex((item) => /anh(?:ä|ae|a)nger|hochlader|kipper|autotransporter|transporter|flatbed/i.test(item.produkt_name_original || ''));
  const targetIndex = trailerIndex === -1 ? 0 : trailerIndex;
  lineItems[targetIndex] = {
    ...lineItems[targetIndex],
    artikelnummern: articleNumbers,
    artikelnummer: articleNumbers[0]
  };
}
