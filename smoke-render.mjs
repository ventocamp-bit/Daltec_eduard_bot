// Smoke-Test: visuelle Verifikation des Tabelle-2-Fixes
import { buildOfferEmail } from './src/core/email-template.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const context = {
  input_language: 'de',
  kunde_vorname: 'Thomas',
  kunde_nachname: 'Mustermann',
  kunde_email: 'thomas.mustermann@example.at',
  hat_match: true,
  top_lager_name: 'Hochlader 331x180x30 3500kg H=63cm',
  kalkulation_anfrage: {
    gesamt_uvp_brutto: 4560,
    gesamt_angebot_brutto: 3970,
    gesamt_rabatt_brutto: 590,
    gesamt_uvp_netto: 3800,
    gesamt_angebot_netto: 3308.33,
    positionen: [
      {
        produkt_name: 'Hochlader 3318 3500kg (inkl. COC & Typisierung)',
        kategorie: 'anhaenger',
        uvp_netto: 3200, angebot_netto: 2784
      },
      {
        produkt_name: 'Plane und Spriegel',
        kategorie: 'zubehoer',
        uvp_netto: 600, angebot_netto: 524.33
      }
    ]
  },
  kalkulation_lager: {
    gesamt_uvp_brutto: 5990.4,
    gesamt_angebot_brutto: 5210,
    gesamt_rabatt_brutto: 780.4,
    gesamt_uvp_netto: 4992,
    gesamt_angebot_netto: 4341.67,
    positionen: [
      {
        produkt_name: 'Hochlader 331x180x30 3500kg H=63cm (Art.Nr: 3318-4-303-3563)',
        kategorie: 'anhaenger',
        uvp_netto: 4492, angebot_netto: 3908.33
      },
      // Defensiv: Zubehör das NICHT in Tabelle 2 erscheinen darf
      {
        produkt_name: 'SOLLTE-NICHT-IN-TABELLE2',
        kategorie: 'zubehoer',
        uvp_netto: 500, angebot_netto: 433.33
      }
    ]
  },
  line_items: [
    { produkt_name_original: 'Hochlader 3318 3500kg LED' },
    { produkt_name_original: 'Plane und Spriegel' }
  ],
  upsell_daten: [{
    // Art.-Nr. absichtlich KEIN exakter Match → hatMatch-Branch (2 Tabellen)
    angefragt: '3318-4-303-3563 Hochlader 3318 3500kg',
    top_upsell: { 'Art.-Nr.': '9999-KEIN-MATCH' }
  }]
};

const result = buildOfferEmail(context, {
  dealer: { locationName: 'Harmannsdorf', defaultDeliveryTime: '4-5 Wochen' },
  signature: {
    greeting: 'Beste Gruesse',
    name: 'Lukas Mitter, MSc',
    company: 'Daltec GmbH',
    address1: 'Esaromstr. 5',
    address2: '2111 Harmannsdorf',
    phone: '+43 676 777 18 00',
    email: 'lukas@daltec.at',
    website: 'Daltec.at'
  }
});

const html = result.html_angebot;

// === CHECKS ===
const checks = [
  { label: '1. Tabelle 1 zeigt Anhänger              ', value:  html.includes('Hochlader 3318 3500kg'), expected: true },
  { label: '2. Tabelle 1 zeigt Zubehör-Sektion        ', value:  html.includes('Plane und Spriegel'), expected: true },
  { label: '3. Tabelle 2 zeigt Lager-Anhänger         ', value:  html.includes('Hochlader 331x180x30'), expected: true },
  { label: '4. Tabelle 2 KEIN Zubehör (Bug-Invariante)', value: !html.includes('SOLLTE-NICHT-IN-TABELLE2'), expected: true },
  { label: '5. Lager-Zubehör-Hinweistext vorhanden    ', value:  /Zubeh.{1,60}Basis-Fahrzeug/s.test(html), expected: true },
  { label: '6. Hinweis-Bubble (LED/Montage) vorhanden ', value:  html.includes('Hinweis LED') || html.includes('Hinweis Montage'), expected: true },
];

console.log('\n=== SMOKE CHECK: feature/fix-tabelle2-zubehoer-filter ===');
let allOk = true;
for (const c of checks) {
  const ok = c.value === c.expected;
  if (!ok) allOk = false;
  console.log(`${ok ? '✅' : '❌ BUG!'} ${c.label}: ${c.value}`);
}
console.log(allOk ? '\n✅ ALLE CHECKS GRÜN' : '\n❌ MINDESTENS EIN CHECK ROT');
console.log('=======================================================\n');

// HTML-Datei schreiben
const outPath = 'C:\\Users\\luca\\.gemini\\antigravity-ide\\brain\\94127413-2f61-4b65-8a5b-8f0572cc3a81\\scratch\\smoke-output.html';
writeFileSync(outPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Smoke Render – fix-tabelle2</title></head><body>${html}</body></html>`, 'utf8');
console.log(`HTML gespeichert: ${outPath}`);
