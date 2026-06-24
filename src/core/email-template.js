import { formatEur } from './format.js';

export const TRANSLATIONS = {
  de: {
    subject: 'Ihr Eduard Angebot',
    salutation: (name) => `Sehr geehrte/r ${name}`.trim(),
    thanks: 'vielen Dank für Ihre Anfrage zu einem Eduard Anhänger.',
    goodNews: 'Gute Nachrichten:',
    exactStockIntro: (location) => `Das von Ihnen konfigurierte Fahrzeug steht sofort auf Lager in ${location} zur Verfügung. Sie können es sich jederzeit ansehen und sofort mitnehmen!`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Wir können Ihnen das gewünschte Fahrzeug zu einem Gesamtpreis von <strong>${offer}</strong> statt ${uvp} anbieten (Rabatt: <strong style='color:${accentColor};'>${discount}</strong>, Lieferzeit ca. ${delivery}).`,
    alternativeIntro: 'Zusätzlich haben wir ein sehr ähnliches Modell sofort auf Lager. Sie können dieses jederzeit besichtigen und sofort mitnehmen!',
    desiredTitle: (delivery) => `Ihre Wunsch-Konfiguration (Lieferzeit ca. ${delivery})`,
    stockTitle: 'Sofort ab Lager verfügbar',
    exactStockText: (location) => `Dieses Fahrzeug steht bereits auf unserem Hof in ${location} inklusive COC &amp; Typisierung:<br><strong>Für Zubehör zum lagernden Basis-Fahrzeug kontaktieren Sie uns bitte per E-Mail oder telefonisch.</strong>`,
    alternativeStockText: (location) => `Alternativ steht dieses sehr ähnliche Fahrzeug sofort auf unserem Hof in ${location} bereit inklusive COC &amp; Typisierung:<br><strong>Für Zubehör zum lagernden Basis-Fahrzeug kontaktieren Sie uns bitte per E-Mail oder telefonisch.</strong>`,
    position: 'Position',
    uvpGross: 'UVP brutto',
    offerGross: 'Angebot brutto',
    total: 'Gesamt',
    totalStock: 'Gesamt ab Lager',
    trailers: 'Anhänger',
    accessories: 'Zubehör',
    copyQuestion: 'Bei Fragen stehe ich Ihnen jederzeit zur Verfügung.',
    regards: 'Beste Grüße',
    hints: {
      ledTitle: 'Hinweis LED-Beleuchtung:',
      ledText: 'Die LED-Beleuchtung eines Anhängers kann unter Umständen zu Problemen beim Zugfahrzeug führen. Grund sind die geringeren Widerstände der LED-Beleuchtung, verglichen mit herkömmlichen H-Birnen. Störungen bei Fahrzeugen gewisser Baujahre der Marken Fiat, Type Ducato (und baugleiche anderer Marken), Iveco Daily und MB-Sprinter sind bekannt. Die Probleme reichen von nicht funktionierenden Zentralverriegelungen bis hin, dass sich der Motor nicht mehr abstellen lässt. Insofern empfehle ich im Regelfall, die LED-Beleuchtung nicht zu wählen. Dieses Problem tritt unabhängig vom Hersteller des Anhängers auf und gilt für alle Marken und Fabrikate.',
      mountingTitle: 'Hinweis Montagekosten für Zubehöre:',
      mountingText: 'Aufsatzbordwände, Laubgitter, und Planen werden lose beigelegt und nicht montiert geliefert. Das notwendige Montagematerial ist im Lieferumfang enthalten. Sollten Sie den Aufbau nicht selbst vornehmen wollen, übernehmen wir dies gerne für Sie. Anbei unsere Montagepreise: Planenknöpfe für Flachplanen: € 60,00 inkl. MwSt. je Bordwandreihe; Hochplanen / Schiebeplanen bis 3,0m Kastenlänge € 300,00 inkl. MwSt; Hochplanen / Schiebeplanen ab 3,0m Kastenlänge € 350,00 inkl. MwSt.',
      pumpTitle: 'Hinweis Elektropumpe:',
      pumpText: 'Sie haben Ihren Anhänger mit einer rein elektrischen Kippeinrichtung konfiguriert. In dieser Ausführung muss die Batterie zum Kippen stets geladen sein, da keine manuelle Bedienung verbaut ist. Wir empfehlen, stattdessen die Elektro-Kombipumpe auszuwählen. Diese beinhaltet neben der elektrischen Kippvorrichtung auch noch eine manuelle Handpumpe für Notfälle.',
      supportsTitle: 'Hinweis Heckstützen:',
      supportsText: 'Wir empfehlen bei allen Kippanhängern sowie Hochladern mit Auffahrrampen das Fahrzeug mit Heckstützen zu konfigurieren. Bei einem Kippvorgang oder beim Auffahren über die Rampen ohne abgeklappte Heckstützen kann es auf Dauer zu schweren Beschädigungen am Anhänger kommen. Insbesondere Rahmenrisse im Bereich der Achsauflage sind die Folge. Die Eduard-Stützfüße sind eine einfache und kostengünstige Variante. Die Höhe der Stützen wird über einen vorgegebenen Lochraster eingestellt. Bei den Winterhoff Teleskopkurbelstützen kann die Stützenhöhe stufenlos über einen Kurbeltrieb an die Situation angepasst werden. Richtpreis Eduard Heckstützen € 90,00 netto / € 108,00 brutto; Richtpreis Winterhoff Kurbelstützen € 280,00 netto / € 336,00 brutto.'
    }
  },
  nl: {
    subject: 'Uw Eduard offerte',
    salutation: (name) => `Geachte ${name}`.trim(),
    thanks: 'bedankt voor uw aanvraag voor een Eduard aanhanger.',
    goodNews: 'Goed nieuws:',
    exactStockIntro: (location) => `Het door u geconfigureerde voertuig is direct uit voorraad beschikbaar in ${location}. U kunt het op elk moment bekijken en direct meenemen!`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Wij kunnen u het gewenste voertuig aanbieden voor een totaalprijs van <strong>${offer}</strong> in plaats van ${uvp} (korting: <strong style='color:${accentColor};'>${discount}</strong>, levertijd ca. ${delivery}).`,
    alternativeIntro: 'Daarnaast hebben wij een zeer vergelijkbaar model direct uit voorraad beschikbaar. U kunt dit op elk moment bekijken en direct meenemen!',
    desiredTitle: (delivery) => `Uw gewenste configuratie (levertijd ca. ${delivery})`,
    stockTitle: 'Direct uit voorraad beschikbaar',
    exactStockText: (location) => `Dit voertuig staat al op ons terrein in ${location}, inclusief COC &amp; typegoedkeuring:<br><strong>Neem voor accessoires voor het voorraadvoertuig contact met ons op per e-mail of telefoon.</strong>`,
    alternativeStockText: (location) => `Als alternatief staat dit zeer vergelijkbare voertuig direct klaar op ons terrein in ${location}, inclusief COC &amp; typegoedkeuring:<br><strong>Neem voor accessoires voor het voorraadvoertuig contact met ons op per e-mail of telefoon.</strong>`,
    position: 'Positie',
    uvpGross: 'Bruto catalogusprijs',
    offerGross: 'Bruto offerte',
    total: 'Totaal',
    totalStock: 'Totaal uit voorraad',
    trailers: 'Aanhanger',
    accessories: 'Accessoires',
    copyQuestion: 'Bij vragen staan wij altijd tot uw beschikking.',
    regards: 'Met vriendelijke groet',
    hints: {}
  },
  fr: {
    subject: 'Votre offre Eduard',
    salutation: (name) => `Bonjour ${name}`.trim(),
    thanks: 'nous vous remercions pour votre demande concernant une remorque Eduard.',
    goodNews: 'Bonne nouvelle :',
    exactStockIntro: (location) => `Le vehicule configure est disponible immediatement en stock a ${location}. Vous pouvez le voir a tout moment et l emporter immediatement !`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Nous pouvons vous proposer le vehicule souhaite au prix total de <strong>${offer}</strong> au lieu de ${uvp} (remise : <strong style='color:${accentColor};'>${discount}</strong>, delai de livraison env. ${delivery}).`,
    alternativeIntro: 'Nous avons egalement un modele tres similaire disponible immediatement en stock.',
    desiredTitle: (delivery) => `Votre configuration souhaitee (delai env. ${delivery})`,
    stockTitle: 'Disponible immediatement en stock',
    exactStockText: (location) => `Ce vehicule est deja disponible sur notre site a ${location}, COC &amp; homologation inclus :<br><strong>Pour les accessoires du vehicule en stock, veuillez nous contacter par e-mail ou par telephone.</strong>`,
    alternativeStockText: (location) => `Alternativement, ce vehicule tres similaire est disponible immediatement sur notre site a ${location}, COC &amp; homologation inclus :<br><strong>Pour les accessoires du vehicule en stock, veuillez nous contacter par e-mail ou par telephone.</strong>`,
    position: 'Position',
    uvpGross: 'Prix brut catalogue',
    offerGross: 'Prix brut offre',
    total: 'Total',
    totalStock: 'Total en stock',
    trailers: 'Remorque',
    accessories: 'Accessoires',
    copyQuestion: 'Nous restons a votre disposition pour toute question.',
    regards: 'Cordialement',
    hints: {}
  },
  cs: {
    subject: 'Va\u0161e nab\u00eddka Eduard',
    salutation: (name) => `V\u00e1\u017een\u00fd z\u00e1kazn\u00edku ${name}`.trim(),
    thanks: 'd\u011bkujeme za va\u0161i popt\u00e1vku na p\u0159\u00edv\u011bs Eduard.',
    goodNews: 'Dobrá zpráva:',
    exactStockIntro: (location) => `V\u00e1mi nakonfigurovan\u00e9 vozidlo je ihned k dispozici ze skladu v ${location}. M\u016f\u017eete si jej kdykoli prohl\u00e9dnout a ihned odv\u00e9zt!`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Po\u017eadovan\u00e9 vozidlo v\u00e1m m\u016f\u017eeme nab\u00eddnout za celkovou cenu <strong>${offer}</strong> m\u00edsto ${uvp} (sleva: <strong style='color:${accentColor};'>${discount}</strong>, dodac\u00ed lh\u016fta cca ${delivery}).`,
    alternativeIntro: 'Krom\u011b toho m\u00e1me velmi podobn\u00fd model ihned k dispozici skladem. M\u016f\u017eete si jej kdykoli prohl\u00e9dnout a ihned odv\u00e9zt!',
    desiredTitle: (delivery) => `Va\u0161e po\u017eadovan\u00e1 konfigurace (dodac\u00ed lh\u016fta cca ${delivery})`,
    stockTitle: 'Ihned k dispozici ze skladu',
    exactStockText: (location) => `Toto vozidlo je ji\u017e na na\u0161em dvo\u0159e v ${location}, v\u010detn\u011b COC &amp; typizace:<br><strong>Ohledn\u011b p\u0159\u00edslu\u0161enstv\u00ed ke skladov\u00e9mu vozidlu n\u00e1s pros\u00edm kontaktujte e-mailem nebo telefonicky.</strong>`,
    alternativeStockText: (location) => `Alternativn\u011b je toto velmi podobn\u00e9 vozidlo ihned k dispozici na na\u0161em dvo\u0159e v ${location}, v\u010detn\u011b COC &amp; typizace:<br><strong>Ohledn\u011b p\u0159\u00edslu\u0161enstv\u00ed ke skladov\u00e9mu vozidlu n\u00e1s pros\u00edm kontaktujte e-mailem nebo telefonicky.</strong>`,
    position: 'Polo\u017eka',
    uvpGross: 'Katalogov\u00e1 cena brutto',
    offerGross: 'Nab\u00eddkov\u00e1 cena brutto',
    total: 'Celkem',
    totalStock: 'Celkem ze skladu',
    trailers: 'P\u0159\u00edv\u011bs',
    accessories: 'P\u0159\u00edslu\u0161enstv\u00ed',
    copyQuestion: 'V p\u0159\u00edpad\u011b dotaz\u016f jsme v\u00e1m kdykoli k dispozici.',
    regards: 'S pozdravem',
    hints: {}
  },
  pl: {
    subject: 'Twoja oferta Eduard',
    salutation: (name) => `Szanowny Kliencie ${name}`.trim(),
    thanks: 'dziekujemy za zapytanie dotyczace przyczepy Eduard.',
    goodNews: 'Dobra wiadomosc:',
    exactStockIntro: (location) => `Skonfigurowany pojazd jest dostepny od reki z magazynu w ${location}.`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Mozemy zaoferowac wybrany pojazd w cenie lacznej <strong>${offer}</strong> zamiast ${uvp} (rabat: <strong style='color:${accentColor};'>${discount}</strong>, czas dostawy ok. ${delivery}).`,
    alternativeIntro: 'Dodatkowo mamy bardzo podobny model dostepny od reki z magazynu.',
    desiredTitle: (delivery) => `Wybrana konfiguracja (czas dostawy ok. ${delivery})`,
    stockTitle: 'Dostepne od reki z magazynu',
    exactStockText: (location) => `Ten pojazd jest juz dostepny na naszym placu w ${location}, wraz z COC &amp; homologacja.`,
    alternativeStockText: (location) => `Alternatywnie ten bardzo podobny pojazd jest dostepny od reki na naszym placu w ${location}, wraz z COC &amp; homologacja.`,
    position: 'Pozycja',
    uvpGross: 'Cena katalogowa brutto',
    offerGross: 'Cena ofertowa brutto',
    total: 'Razem',
    totalStock: 'Razem z magazynu',
    trailers: 'Przyczepa',
    accessories: 'Akcesoria',
    copyQuestion: 'W razie pytan pozostajemy do dyspozycji.',
    regards: 'Z powazaniem',
    hints: {}
  },
  en: {
    subject: 'Your Eduard offer',
    salutation: (name) => `Dear ${name}`.trim(),
    thanks: 'thank you for your inquiry about an Eduard trailer.',
    goodNews: 'Good news:',
    exactStockIntro: (location) => `The vehicle you configured is immediately available from stock in ${location}.`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `We can offer the requested vehicle for a total price of <strong>${offer}</strong> instead of ${uvp} (discount: <strong style='color:${accentColor};'>${discount}</strong>, delivery time approx. ${delivery}).`,
    alternativeIntro: 'We also have a very similar model immediately available from stock.',
    desiredTitle: (delivery) => `Your requested configuration (delivery time approx. ${delivery})`,
    stockTitle: 'Immediately available from stock',
    exactStockText: (location) => `This vehicle is already available at our yard in ${location}, including COC &amp; registration paperwork.`,
    alternativeStockText: (location) => `Alternatively, this very similar vehicle is immediately available at our yard in ${location}, including COC &amp; registration paperwork.`,
    position: 'Position',
    uvpGross: 'Gross list price',
    offerGross: 'Gross offer',
    total: 'Total',
    totalStock: 'Total from stock',
    trailers: 'Trailer',
    accessories: 'Accessories',
    copyQuestion: 'If you have any questions, we are always available.',
    regards: 'Kind regards',
    hints: {}
  },
  it: {
    subject: 'La tua offerta Eduard',
    salutation: (name) => `Gentile ${name}`.trim(),
    thanks: 'grazie per la richiesta relativa a un rimorchio Eduard.',
    goodNews: 'Buone notizie:',
    exactStockIntro: (location) => `Il veicolo configurato e disponibile immediatamente a magazzino a ${location}.`,
    offerIntro: (offer, uvp, discount, delivery, accentColor) => `Possiamo offrirle il veicolo richiesto al prezzo totale di <strong>${offer}</strong> invece di ${uvp} (sconto: <strong style='color:${accentColor};'>${discount}</strong>, tempi di consegna circa ${delivery}).`,
    alternativeIntro: 'Abbiamo inoltre un modello molto simile disponibile immediatamente a magazzino.',
    desiredTitle: (delivery) => `La configurazione richiesta (consegna circa ${delivery})`,
    stockTitle: 'Disponibile immediatamente a magazzino',
    exactStockText: (location) => `Questo veicolo e gia disponibile presso la nostra sede a ${location}, incluso COC &amp; documentazione.`,
    alternativeStockText: (location) => `In alternativa, questo veicolo molto simile e disponibile immediatamente presso la nostra sede a ${location}, incluso COC &amp; documentazione.`,
    position: 'Posizione',
    uvpGross: 'Prezzo lordo di listino',
    offerGross: 'Offerta lorda',
    total: 'Totale',
    totalStock: 'Totale da magazzino',
    trailers: 'Rimorchio',
    accessories: 'Accessori',
    copyQuestion: 'Per qualsiasi domanda restiamo a disposizione.',
    regards: 'Cordiali saluti',
    hints: {}
  }
};

function languageFromContext(context = {}) {
  const language = String(context.input_language || 'de').toLowerCase();
  if (language === 'cz') return 'cs';
  return TRANSLATIONS[language] ? language : 'de';
}

function translated(context = {}) {
  return TRANSLATIONS[languageFromContext(context)];
}

function salutation(context, t) {
  const name = `${context.kunde_vorname || ''} ${context.kunde_nachname || ''}`.replace(/\s+/g, ' ').trim();
  return t.salutation(name || 'Kunde');
}

function normalizeCalc(calc = {}) {
  return {
    uvpBrutto: calc.gesamt_uvp_brutto || 0,
    angebotBrutto: calc.gesamt_angebot_brutto || 0,
    rabattBrutto: calc.gesamt_rabatt_brutto || 0,
    positionen: calc.positionen || []
  };
}

function shortInventoryName(name) {
  return String(name || 'Lagerfahrzeug').replace(/\s+/g, ' ').trim();
}

function getPresentation(settings = {}) {
  return {
    headerBackground: settings.table?.headerBackground || '#f2f2f2',
    borderColor: settings.table?.borderColor || '#dddddd',
    accentColor: settings.table?.accentColor || '#c00000',
    textColor: settings.table?.textColor || '#000000',
    hintBackground: settings.table?.hintBackground || '#f9f9f9'
  };
}

function tableHtml(calc, title, isInventory, settings, t) {
  const colors = getPresentation(settings);
  const normalized = normalizeCalc(calc);
  const rows = groupedPositions(normalized.positionen, isInventory, t).map((entry) => {
    if (entry.section) {
      return `
        <tr>
          <td colspan='3' style='padding:10px 8px;border-bottom:1px solid ${colors.borderColor};background:${colors.headerBackground};font-weight:bold;'>${entry.section}</td>
        </tr>`;
    }
    const position = entry.position;
    return `
        <tr>
          <td style='padding:8px;border-bottom:1px solid ${colors.borderColor};'>${position.produkt_name}</td>
          <td style='padding:8px;border-bottom:1px solid ${colors.borderColor};text-align:right;'>${formatEur(position.uvp_netto * 1.2)}</td>
          <td style='padding:8px;border-bottom:1px solid ${colors.borderColor};text-align:right;'>${formatEur(position.angebot_netto * 1.2)}</td>
        </tr>`;
  }).join('');

  return `
      <h3 style='font-family:Arial,sans-serif;text-align:center;color:${colors.textColor};text-transform:uppercase;margin-top:20px;'>${title}</h3>
      <table style='max-width:800px;width:100%;margin:0 auto;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};'>
        <thead>
          <tr style='background:${colors.headerBackground};'>
            <th style='padding:8px;text-align:left;'>${t.position}</th>
            <th style='padding:8px;text-align:right;'>${t.uvpGross}</th>
            <th style='padding:8px;text-align:right;'>${t.offerGross}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td style='padding:10px;font-weight:bold;'>${isInventory ? t.totalStock : t.total}</td>
            <td style='padding:10px;text-align:right;font-weight:bold;'>${formatEur(normalized.uvpBrutto)}</td>
            <td style='padding:10px;text-align:right;font-weight:bold;color:${colors.accentColor};'>${formatEur(normalized.angebotBrutto)}</td>
          </tr>
        </tfoot>
      </table>`;
}

function groupedPositions(positionen, isInventory, t) {
  if (isInventory) {
    // Tabelle 2 zeigt ausschließlich Anhänger-Positionen.
    // Zubehör (kategorie !== 'anhaenger' && kategorie gesetzt) wird nie in der Lager-Tabelle dargestellt.
    const trailerOnly = positionen.filter((p) => !p.kategorie || p.kategorie === 'anhaenger');
    return trailerOnly.map((position) => ({ position }));
  }


  const trailers = positionen.filter((position) => position.kategorie === 'anhaenger');
  const accessories = positionen.filter((position) => position.kategorie !== 'anhaenger');
  if (trailers.length === 0 || accessories.length === 0) {
    return positionen.map((position) => ({ position }));
  }

  return [
    { section: t.trailers },
    ...trailers.map((position) => ({ position })),
    { section: t.accessories },
    ...accessories.map((position) => ({ position }))
  ];
}

function hintsHtml(allItemsText, settings, t) {
  const colors = getPresentation(settings);
  let hints = '';
  const hintText = { ...TRANSLATIONS.de.hints, ...(t.hints || {}) };

  if (/led/i.test(allItemsText)) {
    hints += hintParagraph(colors, hintText.ledTitle, hintText.ledText);
  }

  if (/aufsatzbordw|laubgitter|plane/i.test(allItemsText)) {
    hints += hintParagraph(colors, hintText.mountingTitle, hintText.mountingText);
  }

  if (/kipper|rückwärts|rueckwaerts|ruckwaerts/i.test(allItemsText) && /e-pumpe|elektrisch/i.test(allItemsText) && !/kombipumpe|nothand/i.test(allItemsText)) {
    hints += hintParagraph(colors, hintText.pumpTitle, hintText.pumpText);
  }

  if ((/kipper|rückwärts|rueckwaerts|ruckwaerts/i.test(allItemsText) || (/hochlader/i.test(allItemsText) && /rampe|auffahrschien/i.test(allItemsText))) && !/heckstütz|heckstuetz|stützfuß|stuetzfuss|kurbelstütz|kurbelstuetz/i.test(allItemsText)) {
    hints += hintParagraph(colors, hintText.supportsTitle, hintText.supportsText);
  }

  return hints ? `<div style='max-width:800px;margin:20px auto;padding:20px;border:1px solid #ccc;background:${colors.hintBackground};'>${hints}</div>` : '';
}

function hintParagraph(colors, title, text) {
  return `<p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};margin-bottom:15px;line-height:1.5;'><strong>${title}</strong> ${text}</p>`;
}

function getSignature(settings = {}, t = TRANSLATIONS.de) {
  return {
    greeting: t.regards,
    name: 'Lukas Mitter, MSc',
    company: 'Daltec GmbH',
    address1: 'Esaromstr. 5 (Ecke Bahnhofplatz)',
    address2: '2111 Harmannsdorf - Rückersdorf',
    phone: 'Büro: +43 676 777 18 00',
    email: 'Email: lukas@daltec.at',
    website: 'Website: Daltec.at',
    ...(settings.signature || {})
  };
}

export function buildOfferEmail(context, settings = {}) {
  const t = translated(context);
  const colors = getPresentation(settings);
  const signature = getSignature(settings, t);
  const copyQuestion = settings.mail?.copyQuestion || t.copyQuestion;
  const locationName = settings.dealer?.locationName || 'Harmannsdorf';
  const defaultDeliveryTime = settings.dealer?.defaultDeliveryTime || '4-5 Wochen';
  const anfrageCalc = context.kalkulation_anfrage;
  const lagerCalc = context.kalkulation_lager;
  const hatMatch = context.hat_match && lagerCalc;
  const lagerName = shortInventoryName(context.top_lager_name);
  const norm = normalizeCalc(anfrageCalc);
  const upsellDaten = context.upsell_daten || [];
  const allItemsText = [
    ...(context.line_items || []).map((item) => item.produkt_name_original),
    ...norm.positionen.map((item) => item.produkt_name)
  ].join(' ').toLowerCase();

  const anfrageArtNr = String(upsellDaten[0]?.angefragt || '').match(/\d{4}-\d+-[A-Z0-9]+-\d+/i)?.[0] || '';
  const lagerArtNr = upsellDaten[0]?.top_upsell?.['Art.-Nr.'] || '';
  const istExaktMatch = hatMatch && lagerArtNr && (
    anfrageArtNr === lagerArtNr ||
    String(upsellDaten[0]?.angefragt || '').includes(String(lagerArtNr).split('-').slice(0, 2).join('-'))
  );

  let introText = '';
  let tables = '';

  if (istExaktMatch) {
    introText = `${t.thanks} <strong>${t.goodNews}</strong> ${t.exactStockIntro(locationName)}`;
    tables = `
      <h3 style='font-family:Arial,sans-serif;text-align:center;color:${colors.textColor};text-transform:uppercase;margin-top:10px;'>${t.stockTitle}</h3>
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};text-align:center;max-width:800px;margin:0 auto 15px auto;'>${t.exactStockText(locationName)}</p>
      ${tableHtml(lagerCalc, lagerName, true, settings, t)}`;
  } else if (hatMatch) {
    introText = `${t.thanks} ${t.offerIntro(formatEur(norm.angebotBrutto), formatEur(norm.uvpBrutto), formatEur(norm.rabattBrutto), defaultDeliveryTime, colors.accentColor)} ${t.alternativeIntro}`;
    tables = `
      ${tableHtml(anfrageCalc, t.desiredTitle(defaultDeliveryTime), false, settings, t)}
      <h3 style='font-family:Arial,sans-serif;text-align:center;color:${colors.textColor};text-transform:uppercase;margin-top:40px;'>${t.stockTitle}</h3>
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};text-align:center;max-width:800px;margin:0 auto 15px auto;'>${t.alternativeStockText(locationName)}</p>
      ${tableHtml(lagerCalc, lagerName, true, settings, t)}`;
  } else {
    introText = `${t.thanks} ${t.offerIntro(formatEur(norm.angebotBrutto), formatEur(norm.uvpBrutto), formatEur(norm.rabattBrutto), defaultDeliveryTime, colors.accentColor)}`;
    tables = tableHtml(anfrageCalc, t.desiredTitle(defaultDeliveryTime), false, settings, t);
  }

  const kundenEmail = context.kunde_email || 'keine@email.com';
  const kundenName = `${context.kunde_vorname || ''} ${context.kunde_nachname || ''}`.trim();

  const html = `
    <div style='width:100%;text-align:center;background-color:#ffffff;padding:20px 0;'>
      <div style='max-width:800px;margin:0 auto 20px auto;text-align:left;font-family:Arial,sans-serif;font-size:13px;color:#444;border:1px solid #ccc;background-color:#f4f4f4;padding:10px;border-radius:4px;'>
        <strong>Kunden E-Mail kopieren:</strong><br>
        <span style='user-select:all;-webkit-user-select:all;display:inline-block;background:#fff;padding:4px 8px;margin-top:5px;border:1px solid #bbb;border-radius:3px;cursor:pointer;color:#000;font-weight:bold;'>${kundenEmail}</span>
      </div>
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};max-width:800px;margin:0 auto 25px auto;text-align:left;line-height:1.5;'>
        ${salutation(context, t)},<br><br>
        ${introText} ${copyQuestion}
      </p>
      ${tables}
      ${hintsHtml(allItemsText, settings, t)}
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};max-width:800px;margin:40px auto 0 auto;text-align:left;'>
        ${signature.greeting}<br><br>
        <strong>${signature.name}</strong><br>
        <span style='font-size:12px;color:#666;line-height:1.6;'>
          ${signature.company}<br>
          ${signature.address1}<br>
          ${signature.address2}<br>
          ${signature.phone}<br>
          ${signature.email}<br>
          ${signature.website}
        </span>
      </p>
    </div>`;

  return {
    html_angebot: html,
    email: kundenEmail,
    betreff: `${t.subject} - ${kundenName}`
  };
}
