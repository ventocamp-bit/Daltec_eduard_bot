import { parseEuroNumber, stripHtml } from './format.js';

const FIELD_MAP = {
  vorname: ['vorname', 'jméno', 'jmÃ©no', 'naam', 'prénom', 'voornaam', 'first name', 'nome', 'imię'],
  nachname: ['nachname', 'příjmení', 'pÅ™Ã­jmenÃ­', 'achternaam', 'nom', 'familienaam', 'last name', 'cognome', 'nazwisko'],
  email: ['e-mail-adresse', 'emailová adresa', 'emailovÃ¡ adresa', 'e-mailadres', 'adresse e-mail', 'email address', 'adres e-mail', 'indirizzo e-mail'],
  telefon: ['telefonnummer', 'telefonní číslo', 'telefonnÃ­ ÄÃ­slo', 'telefoonnummer', 'numéro de téléphone', 'phone number', 'numer telefonu', 'numero di telefono'],
  adresse: ['adresse', 'adresa', 'adres', 'address', 'indirizzo']
};

FIELD_MAP.vorname.push('jm\u00e9no', 'voornaam', 'pr\u00e9nom', 'imi\u0119', 'first name', 'nome');
FIELD_MAP.nachname.push('p\u0159\u00edjmen\u00ed', 'achternaam', 'familienaam', 'nom', 'nazwisko', 'last name', 'cognome');
FIELD_MAP.email.push('emailov\u00e1 adresa', 'e-mailadres', 'adresse e-mail', 'adres e-mail', 'email address', 'indirizzo e-mail');
FIELD_MAP.telefon.push('telefonn\u00ed \u010d\u00edslo', 'telefoonnummer', 'num\u00e9ro de t\u00e9l\u00e9phone', 'numer telefonu', 'phone number', 'numero di telefono');
FIELD_MAP.adresse.push('adresa', 'adres', 'adresse', 'address', 'indirizzo');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STOP_LABELS = /^(Preis|MwSt|Preis inkl\. MwSt|Gesamt|Fragen|Bemerkungen|Konfiguration|Cena|DPH|Cena vč\. DPH|Nastavení|Otázky\/Připomínky\?)$/i;

function extractTableValue(html, label) {
  const escapedLabel = escapeRegex(label);
  const regex = new RegExp(
    `<td[^>]*>\\s*<strong[^>]*>\\s*${escapedLabel}\\s*<\\/strong>\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
    'i'
  );
  const match = String(html || '').match(regex);
  return match ? stripHtml(match[1]) : '';
}

function extractPlainValue(text, label) {
  const escapedLabel = escapeRegex(label);
  const regex = new RegExp(`(?:^|\\r?\\n)\\s*${escapedLabel}\\s*(?:\\r?\\n|\\s{2,})([^\\n\\r]+)`, 'i');
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

const LANGUAGE_SIGNALS = [
  { language: 'cs', patterns: [/jm[eě]no/i, /p[řr]ijmen[ií]/i, /emailov[aá] adresa/i, /telefonn[ií] [cč][ií]slo/i, /nov[aá] popt[aá]vka/i] },
  { language: 'nl', patterns: [/voornaam/i, /achternaam/i, /e-mailadres/i, /telefoonnummer/i, /\bofferte\b/i, /\baanvraag\b/i] },
  { language: 'fr', patterns: [/pr[eé]nom/i, /\bnom\b/i, /adresse e-mail/i, /num[eé]ro de t[eé]l[eé]phone/i, /demande de devis/i] },
  { language: 'pl', patterns: [/imi[eę]/i, /nazwisko/i, /adres e-mail/i, /numer telefonu/i, /zapytanie/i] },
  { language: 'en', patterns: [/first name/i, /last name/i, /email address/i, /phone number/i, /offer request/i] },
  { language: 'it', patterns: [/\bnome\b/i, /cognome/i, /indirizzo e-mail/i, /numero di telefono/i, /richiesta offerta/i] }
];

function normalizeLanguageText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function detectInputLanguage(raw = {}, html = '', text = '') {
  const haystack = normalizeLanguageText([
    raw.subject || raw.Subject || '',
    text,
    stripHtml(html)
  ].join('\n'));

  for (const signal of LANGUAGE_SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(haystack))) return signal.language;
  }
  return 'de';
}

export function extractInquiry(raw = {}) {
  const html = raw.html || raw.bodyHtml || '';
  const text = raw.text || raw.bodyText || '';
  const inputLanguage = detectInputLanguage(raw, html, text);
  const articleNumbers = extractArticleNumbers(text || stripHtml(html));

  const vorname = extractAnyValue(html, text, ['Vorname', 'Jméno']) || 'Kunde';
  const nachname = extractAnyValue(html, text, ['Nachname', 'Příjmení']) || 'Unbekannt';
  const adresse = extractAnyValue(html, text, ['Adresse', 'Adresa']) || '';
  const telefon = extractAnyValue(html, text, ['Telefonnummer', 'Telefonní číslo']) || '';

  const emailRaw = extractAnyValue(html, text, ['E-mail-Adresse', 'Emailová adresa']) || '';
  const emailMatch = emailRaw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const mappedVorname = extractAnyValue(html, text, FIELD_MAP.vorname) || vorname;
  const mappedNachname = extractAnyValue(html, text, FIELD_MAP.nachname) || nachname;
  const mappedAdresse = extractAnyValue(html, text, FIELD_MAP.adresse) || adresse;
  const mappedTelefon = extractAnyValue(html, text, FIELD_MAP.telefon) || telefon;
  const mappedEmailRaw = extractAnyValue(html, text, FIELD_MAP.email) || emailRaw;
  const mappedEmailMatch = mappedEmailRaw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);

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
    kunde_vorname: mappedVorname,
    kunde_nachname: mappedNachname,
    kunde_email: mappedEmailMatch ? mappedEmailMatch[1] : 'keine@email.com',
    kunde_adresse: mappedAdresse,
    kunde_telefon: mappedTelefon,
    input_language: inputLanguage,
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
