import { formatEur } from './format.js';

function salutation(vorname, nachname) {
  return `Sehr geehrte/r ${vorname || ''} ${nachname || ''}`.replace(/\s+/g, ' ').trim();
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

function tableHtml(calc, title, isInventory, settings) {
  const colors = getPresentation(settings);
  const normalized = normalizeCalc(calc);
  const rows = groupedPositions(normalized.positionen, isInventory).map((entry) => {
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
            <th style='padding:8px;text-align:left;'>Position</th>
            <th style='padding:8px;text-align:right;'>UVP brutto</th>
            <th style='padding:8px;text-align:right;'>Angebot brutto</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td style='padding:10px;font-weight:bold;'>Gesamt${isInventory ? ' ab Lager' : ''}</td>
            <td style='padding:10px;text-align:right;font-weight:bold;'>${formatEur(normalized.uvpBrutto)}</td>
            <td style='padding:10px;text-align:right;font-weight:bold;color:${colors.accentColor};'>${formatEur(normalized.angebotBrutto)}</td>
          </tr>
        </tfoot>
      </table>`;
}

function groupedPositions(positionen, isInventory) {
  if (isInventory) return positionen.map((position) => ({ position }));

  const trailers = positionen.filter((position) => position.kategorie === 'anhaenger');
  const accessories = positionen.filter((position) => position.kategorie !== 'anhaenger');
  if (trailers.length === 0 || accessories.length === 0) {
    return positionen.map((position) => ({ position }));
  }

  return [
    { section: 'Anhänger' },
    ...trailers.map((position) => ({ position })),
    { section: 'Zubehör' },
    ...accessories.map((position) => ({ position }))
  ];
}

function hintsHtml(allItemsText, settings) {
  const colors = getPresentation(settings);
  let hints = '';

  if (/led/i.test(allItemsText)) {
    hints += hintParagraph(
      colors,
      'Hinweis LED-Beleuchtung:',
      'Die LED-Beleuchtung eines Anhängers kann unter Umständen zu Problemen beim Zugfahrzeug führen. Grund sind die geringeren Widerstände der LED-Beleuchtung, verglichen mit herkömmlichen H-Birnen. Störungen bei Fahrzeugen gewisser Baujahre der Marken Fiat, Type Ducato (und baugleiche anderer Marken), Iveco Daily und MB-Sprinter sind bekannt. Die Probleme reichen von nicht funktionierenden Zentralverriegelungen bis hin, dass sich der Motor nicht mehr abstellen lässt. Insofern empfehle ich im Regelfall, die LED-Beleuchtung nicht zu wählen. Dieses Problem tritt unabhängig vom Hersteller des Anhängers auf und gilt für alle Marken und Fabrikate.'
    );
  }

  if (/aufsatzbordw|laubgitter|plane/i.test(allItemsText)) {
    hints += hintParagraph(
      colors,
      'Hinweis Montagekosten für Zubehöre:',
      'Aufsatzbordwände, Laubgitter, und Planen werden lose beigelegt und nicht montiert geliefert. Das notwendige Montagematerial ist im Lieferumfang enthalten. Sollten Sie den Aufbau nicht selbst vornehmen wollen, übernehmen wir dies gerne für Sie. Anbei unsere Montagepreise: Planenknöpfe für Flachplanen: € 60,00 inkl. MwSt. je Bordwandreihe; Hochplanen / Schiebeplanen bis 3,0m Kastenlänge € 300,00 inkl. MwSt; Hochplanen / Schiebeplanen ab 3,0m Kastenlänge € 350,00 inkl. MwSt.'
    );
  }

  if (/kipper|rückwärts|rueckwaerts|ruckwaerts/i.test(allItemsText) && /e-pumpe|elektrisch/i.test(allItemsText) && !/kombipumpe|nothand/i.test(allItemsText)) {
    hints += hintParagraph(
      colors,
      'Hinweis Elektropumpe:',
      'Sie haben Ihren Anhänger mit einer rein elektrischen Kippeinrichtung konfiguriert. In dieser Ausführung muss die Batterie zum Kippen stets geladen sein, da keine manuelle Bedienung verbaut ist. Wir empfehlen, stattdessen die Elektro-Kombipumpe auszuwählen. Diese beinhaltet neben der elektrischen Kippvorrichtung auch noch eine manuelle Handpumpe für Notfälle.'
    );
  }

  if ((/kipper|rückwärts|rueckwaerts|ruckwaerts/i.test(allItemsText) || (/hochlader/i.test(allItemsText) && /rampe|auffahrschien/i.test(allItemsText))) && !/heckstütz|heckstuetz|stützfuß|stuetzfuss|kurbelstütz|kurbelstuetz/i.test(allItemsText)) {
    hints += hintParagraph(
      colors,
      'Hinweis Heckstützen:',
      'Wir empfehlen bei allen Kippanhängern sowie Hochladern mit Auffahrrampen das Fahrzeug mit Heckstützen zu konfigurieren. Bei einem Kippvorgang oder beim Auffahren über die Rampen ohne abgeklappte Heckstützen kann es auf Dauer zu schweren Beschädigungen am Anhänger kommen. Insbesondere Rahmenrisse im Bereich der Achsauflage sind die Folge. Die Eduard-Stützfüße sind eine einfache und kostengünstige Variante. Die Höhe der Stützen wird über einen vorgegebenen Lochraster eingestellt. Bei den Winterhoff Teleskopkurbelstützen kann die Stützenhöhe stufenlos über einen Kurbeltrieb an die Situation angepasst werden. Richtpreis Eduard Heckstützen € 90,00 netto / € 108,00 brutto; Richtpreis Winterhoff Kurbelstützen € 280,00 netto / € 336,00 brutto.'
    );
  }

  return hints ? `<div style='max-width:800px;margin:20px auto;padding:20px;border:1px solid #ccc;background:${colors.hintBackground};'>${hints}</div>` : '';
}

function hintParagraph(colors, title, text) {
  return `<p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};margin-bottom:15px;line-height:1.5;'><strong>${title}</strong> ${text}</p>`;
}

function getSignature(settings = {}) {
  return {
    greeting: 'Beste Grüße',
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
  const colors = getPresentation(settings);
  const signature = getSignature(settings);
  const copyQuestion = settings.mail?.copyQuestion || 'Bei Fragen stehe ich Ihnen jederzeit zur Verfügung.';
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
    introText = `vielen Dank für Ihre Anfrage zu einem Eduard Anhänger. <strong>Gute Nachrichten:</strong> Das von Ihnen konfigurierte Fahrzeug steht sofort auf Lager in ${locationName} zur Verfügung. Sie können es sich jederzeit ansehen und sofort mitnehmen!`;
    tables = `
      <h3 style='font-family:Arial,sans-serif;text-align:center;color:${colors.textColor};text-transform:uppercase;margin-top:10px;'>Sofort ab Lager verfügbar</h3>
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};text-align:center;max-width:800px;margin:0 auto 15px auto;'>Dieses Fahrzeug steht bereits auf unserem Hof in ${locationName} inklusive COC &amp; Typisierung:<br><strong>Für Zubehör zum lagernden Basis-Fahrzeug kontaktieren Sie uns bitte per E-Mail oder telefonisch.</strong></p>
      ${tableHtml(lagerCalc, lagerName, true, settings)}`;
  } else if (hatMatch) {
    introText = `vielen Dank für Ihre Anfrage zu einem Eduard Anhänger. Wir können Ihnen das gewünschte Fahrzeug zu einem Gesamtpreis von <strong>${formatEur(norm.angebotBrutto)}</strong> statt ${formatEur(norm.uvpBrutto)} anbieten (Rabatt: <strong style='color:${colors.accentColor};'>${formatEur(norm.rabattBrutto)}</strong>, Lieferzeit ca. ${defaultDeliveryTime}). Zusätzlich haben wir ein sehr ähnliches Modell sofort auf Lager. Sie können dieses jederzeit besichtigen und sofort mitnehmen!`;
    tables = `
      ${tableHtml(anfrageCalc, `Ihre Wunsch-Konfiguration (Lieferzeit ca. ${defaultDeliveryTime})`, false, settings)}
      <h3 style='font-family:Arial,sans-serif;text-align:center;color:${colors.textColor};text-transform:uppercase;margin-top:40px;'>Sofort ab Lager verfügbar</h3>
      <p style='font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};text-align:center;max-width:800px;margin:0 auto 15px auto;'>Alternativ steht dieses sehr ähnliche Fahrzeug sofort auf unserem Hof in ${locationName} bereit inklusive COC &amp; Typisierung:<br><strong>Für Zubehör zum lagernden Basis-Fahrzeug kontaktieren Sie uns bitte per E-Mail oder telefonisch.</strong></p>
      ${tableHtml(lagerCalc, lagerName, true, settings)}`;
  } else {
    introText = `vielen Dank für Ihre Anfrage zu einem Eduard Anhänger. Wir können Ihnen das gewünschte Fahrzeug zu einem Gesamtpreis von <strong>${formatEur(norm.angebotBrutto)}</strong> statt ${formatEur(norm.uvpBrutto)} anbieten (Rabatt: <strong style='color:${colors.accentColor};'>${formatEur(norm.rabattBrutto)}</strong>, Lieferzeit ca. ${defaultDeliveryTime}).`;
    tables = tableHtml(anfrageCalc, `Ihre Wunsch-Konfiguration (Lieferzeit ca. ${defaultDeliveryTime})`, false, settings);
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
        ${salutation(context.kunde_vorname, context.kunde_nachname)},<br><br>
        ${introText} ${copyQuestion}
      </p>
      ${tables}
      ${hintsHtml(allItemsText, settings)}
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
    betreff: `Ihr Eduard Angebot - ${kundenName}`
  };
}
