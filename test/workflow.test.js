import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInquiry } from '../src/core/parser.js';
import { buildOfferEmail } from '../src/core/email-template.js';
import { calculateInquiryOffer, resolveProductCategory } from '../src/core/pricing.js';
import { matchInventory, getTrailerType } from '../src/core/inventory.js';
import { validateInventoryCsv } from '../src/core/csv-validator.js';
import { atomicWriteFile, decodeCsvBuffer, readCsvObjects } from '../src/adapters/local-data.js';
import { runWorkflow } from '../src/workflow.js';
import { appendOfferRecord, getOnboardingChecklist, ingestInboundMessage, listOfferRecords, saveTenant } from '../src/storage.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { listTenantContexts, tenantContext } from '../src/tenant-context.js';
import { resolveTenantContextForInbound } from '../src/dealer-routing.js';
import { createMailRuntime } from '../src/mail-runtime.js';
import { isInternalOwnerDraft } from '../src/internal-mail.js';
import { labelForIgnoredRun, labelForProcessedRun } from '../src/mail-labels.js';
import { buildReplayReport, replayMessages } from '../src/replay.js';
import { defaultExportQuery, isProofCandidate } from '../src/export-mails.js';
import { buildUnreadQuery } from '../src/adapters/google.js';
import { isInventoryImportMessage, listInventoryImports, processInventoryImportMessage } from '../src/inventory-import.js';
import { processMailMessage } from '../src/index.js';
import { strToU8, zipSync } from 'fflate';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('extracts customer and line items from Eduard HTML table', () => {
  const result = extractInquiry({
    html: `
      <table>
        <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
        <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
        <tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>
        <tr><td>Hochlader 3318 3500kg</td><td>€ 3.000,00</td></tr>
        <tr><td>COC & Typisierung</td><td>€ 200,00</td></tr>
      </table>`
  });

  assert.equal(result.kunde_vorname, 'Max');
  assert.equal(result.kunde_email, 'max@example.com');
  assert.equal(result.line_items.length, 2);
});

test('extracts Czech Eduard inquiries without treating CZK as Euro', () => {
  const result = extractInquiry({
    text: [
      'Jméno',
      'Václav',
      'Příjmení',
      'Běhunčík',
      'Emailová adresa',
      'vaclav.behuncik@gmail.com',
      'Telefonní číslo',
      '+420736744484',
      '4020 -BT- Flatbed, ramps, without sides -2000kg- Lh: 56cm -195/55R10',
      'Kč 83.611,57',
      'Shock absorbers',
      'Kč 4.198,35',
      'Kódy položek pro přívěsy a příslušenství:',
      '* 4020-4-POV-2056'
    ].join('\n')
  });

  assert.equal(result.kunde_vorname, 'Václav');
  assert.equal(result.kunde_nachname, 'Běhunčík');
  assert.equal(result.kunde_email, 'vaclav.behuncik@gmail.com');
  assert.equal(result.line_items.length, 2);
  assert.equal(result.line_items[0].unsupported_currency, 'CZK');
  assert.equal(result.line_items[0].artikelnummer, '4020-4-POV-2056');
  assert.equal(result.line_items[0].preis_mail_brutto_num, 0);
});

test('extracts multilingual customer labels from Eduard inquiries', () => {
  const czech = extractInquiry({
    text: [
      'jméno',
      'Václav',
      'příjmení',
      'Běhunčík',
      'emailová adresa',
      'vaclav.behuncik@example.cz',
      'telefonní číslo',
      '+420736744484',
      'Hochlader 3318 3500kg € 3.000,00'
    ].join('\n')
  });

  const german = extractInquiry({
    text: [
      'Vorname',
      'Max',
      'Nachname',
      'Mustermann',
      'E-mail-Adresse',
      'max@example.com',
      'Telefonnummer',
      '+431234567',
      'Hochlader 3318 3500kg € 3.000,00'
    ].join('\n')
  });

  const dutch = extractInquiry({
    text: [
      'naam',
      'Jan',
      'achternaam',
      'Jansen',
      'e-mailadres',
      'jan.jansen@example.nl',
      'telefoonnummer',
      '+31201234567',
      'Hochlader 3318 3500kg € 3.000,00'
    ].join('\n')
  });

  assert.equal(czech.kunde_vorname, 'Václav');
  assert.equal(czech.kunde_nachname, 'Běhunčík');
  assert.equal(czech.kunde_email, 'vaclav.behuncik@example.cz');
  assert.equal(czech.kunde_telefon, '+420736744484');
  assert.equal(german.kunde_vorname, 'Max');
  assert.equal(german.kunde_nachname, 'Mustermann');
  assert.equal(german.kunde_email, 'max@example.com');
  assert.equal(dutch.kunde_vorname, 'Jan');
  assert.equal(dutch.kunde_nachname, 'Jansen');
  assert.equal(dutch.kunde_email, 'jan.jansen@example.nl');
});

test('extracts DE CZ NL FR PL EN IT customer labels from Eduard inquiries', () => {
  const fixtures = [
    {
      language: 'DE',
      labels: ['Vorname', 'Nachname', 'E-mail-Adresse', 'Telefonnummer', 'Adresse'],
      expected: ['Max', 'Mustermann', 'max@example.de', '+431234567', 'Hauptstrasse 1, Wien']
    },
    {
      language: 'CZ',
      labels: ['Jm\u00e9no', 'P\u0159\u00edjmen\u00ed', 'Emailov\u00e1 adresa', 'Telefonn\u00ed \u010d\u00edslo', 'Adresa'],
      expected: ['Vaclav', 'Behuncik', 'vaclav.behuncik@example.cz', '+420736744484', 'Dlouha 1, Praha']
    },
    {
      language: 'NL',
      labels: ['Voornaam', 'Achternaam', 'E-mailadres', 'Telefoonnummer', 'Adres'],
      expected: ['Jan', 'Jansen', 'jan.jansen@example.nl', '+31201234567', 'Damrak 1, Amsterdam']
    },
    {
      language: 'FR',
      labels: ['Pr\u00e9nom', 'Nom', 'Adresse e-mail', 'Num\u00e9ro de t\u00e9l\u00e9phone', 'Adresse'],
      expected: ['Jean', 'Dupont', 'jean.dupont@example.fr', '+33123456789', 'Rue de Paris 1, Paris']
    },
    {
      language: 'PL',
      labels: ['Imi\u0119', 'Nazwisko', 'Adres e-mail', 'Numer telefonu', 'Adres'],
      expected: ['Jan', 'Kowalski', 'jan.kowalski@example.pl', '+48123456789', 'Dluga 1, Warszawa']
    },
    {
      language: 'EN',
      labels: ['First name', 'Last name', 'Email address', 'Phone number', 'Address'],
      expected: ['John', 'Smith', 'john.smith@example.com', '+441234567890', 'High Street 1, London']
    },
    {
      language: 'IT',
      labels: ['Nome', 'Cognome', 'Indirizzo e-mail', 'Numero di telefono', 'Indirizzo'],
      expected: ['Mario', 'Rossi', 'mario.rossi@example.it', '+391234567890', 'Via Roma 1, Milano']
    }
  ];

  for (const fixture of fixtures) {
    const [firstName, lastName, email, phone, address] = fixture.expected;
    const result = extractInquiry({
      text: [
        fixture.labels[0],
        firstName,
        fixture.labels[1],
        lastName,
        fixture.labels[2],
        email,
        fixture.labels[3],
        phone,
        fixture.labels[4],
        address,
        'Hochlader 3318 3500kg â‚¬ 3.000,00'
      ].join('\n')
    });

    assert.equal(result.kunde_vorname, firstName, fixture.language);
    assert.equal(result.kunde_nachname, lastName, fixture.language);
    assert.equal(result.kunde_email, email, fixture.language);
    assert.equal(result.kunde_telefon, phone, fixture.language);
    assert.equal(result.kunde_adresse, address, fixture.language);
  }
});

test('detects input language from Eduard subject and field labels', () => {
  const fixtures = [
    { expected: 'de', subject: 'Neue Eduard Anfrage', labels: ['Vorname', 'Nachname', 'E-mail-Adresse'] },
    { expected: 'nl', subject: 'Eduard offerte aanvraag', labels: ['Voornaam', 'Achternaam', 'E-mailadres'] },
    { expected: 'fr', subject: 'Demande de devis Eduard', labels: ['Pr\u00e9nom', 'Nom', 'Adresse e-mail'] },
    { expected: 'cs', subject: 'Nov\u00e1 popt\u00e1vka Eduard', labels: ['Jm\u00e9no', 'P\u0159\u00edjmen\u00ed', 'Emailov\u00e1 adresa'] },
    { expected: 'pl', subject: 'Zapytanie Eduard', labels: ['Imi\u0119', 'Nazwisko', 'Adres e-mail'] },
    { expected: 'en', subject: 'Eduard offer request', labels: ['First name', 'Last name', 'Email address'] },
    { expected: 'it', subject: 'Richiesta offerta Eduard', labels: ['Nome', 'Cognome', 'Indirizzo e-mail'] }
  ];

  for (const fixture of fixtures) {
    const result = extractInquiry({
      subject: fixture.subject,
      text: [
        fixture.labels[0],
        'Alex',
        fixture.labels[1],
        'Customer',
        fixture.labels[2],
        `${fixture.expected}@example.com`,
        'Hochlader 3318 3500kg â‚¬ 3.000,00'
      ].join('\n')
    });

    assert.equal(result.input_language, fixture.expected, fixture.expected);
  }
});

test('extracts Eduard SKU NOT FOUND information requests as reviewable line items', () => {
  const result = extractInquiry({
    text: [
      'Vorname',
      'FLORIN',
      'Nachname',
      'PINCOTAN',
      'E-mail-Adresse',
      'OFFICE@KFZ-Florin.com',
      'Angefragter Anhänger und Zubehör (Artikelcodes)',
      '* 4018-4-AO3-3563-N - SKU NOT FOUND'
    ].join('\n')
  });

  assert.equal(result.kunde_vorname, 'FLORIN');
  assert.equal(result.kunde_email, 'OFFICE@KFZ-Florin.com');
  assert.equal(result.line_items.length, 1);
  assert.equal(result.line_items[0].is_sku_not_found, true);
  assert.equal(result.line_items[0].artikelnummer, '4018-4-AO3-3563-N');
});

test('calculates 87 percent rounded offer like the n8n workflow', () => {
  const inquiry = {
    line_items: [
      { produkt_name_original: 'Hochlader 3318 3500kg', preis_mail_brutto_num: 3000 },
      { produkt_name_original: 'COC & Typisierung', preis_mail_brutto_num: 200 }
    ]
  };

  const result = calculateInquiryOffer(inquiry);
  assert.equal(result.kalkulation_anfrage.gesamt_uvp_brutto, 3840);
  assert.equal(result.kalkulation_anfrage.gesamt_angebot_brutto, 3350);
  assert.match(result.kalkulation_anfrage.positionen[0].produkt_name, /inkl\. COC/);
  assert.equal(result.kalkulation_anfrage.positionen[0].kategorie, 'anhaenger');
});

test('applies separate trailer and accessory discount rules', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        <tr><td>Plane und Spriegel</td><td>&euro; 500,00</td></tr>
      </table>`
  }, {
    settings: {
      pricing: {
        offerFactor: 0.87,
        roundTo: 1,
        vatRate: 0.2,
        categoryDiscounts: {
          anhaenger: 10,
          zubehoer: 30
        }
      }
    }
  });

  assert.equal(result.priced.kalkulation_anfrage.gesamt_uvp_brutto, 4200);
  assert.equal(result.priced.kalkulation_anfrage.gesamt_angebot_brutto, 3660);
});

test('applies product specific UVP discount rules before category defaults', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        <tr><td>Plane und Spriegel</td><td>&euro; 500,00</td></tr>
      </table>`
  }, {
    settings: {
      pricing: {
        offerFactor: 1,
        roundTo: 1,
        vatRate: 0.2,
        categoryDiscounts: {
          anhaenger: 0,
          zubehoer: 0
        },
        rules: [
          { match: 'Hochlader', category: 'anhaenger', source: 'uvp_discount', percent: 20, enabled: true }
        ]
      }
    }
  });

  assert.equal(result.priced.kalkulation_anfrage.gesamt_angebot_brutto, 3480);
  assert.equal(result.priced.kalkulation_anfrage.price_source, 'eduard_mail');
  assert.equal(result.priced.kalkulation_anfrage.vat_rate, 0.2);
  assert.equal(result.priced.kalkulation_anfrage.applied_rules[0].id, 'rule:0');
  assert.equal(result.priced.kalkulation_anfrage.positionen[0].discount_type, 'uvp_discount');
});

test('applies configurable product group discounts for trailers spare parts and accessories', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 10.000,00</td></tr>
        <tr><td>Hydraulik Schlauch Ersatzteil</td><td>&euro; 500,00</td></tr>
        <tr><td>Plane und Spriegel</td><td>&euro; 1.000,00</td></tr>
      </table>`
  }, {
    settings: {
      pricing: {
        offerFactor: 1,
        roundTo: 1,
        vatRate: 0.2,
        categoryDiscounts: {
          anhaenger: 5,
          ersatzteile: 40,
          zubehoer: 10
        },
        productGroups: [
          { id: 'anhaenger', label: 'Anhaenger', match: 'anhaenger,hochlader', enabled: true },
          { id: 'ersatzteile', label: 'Ersatzteile', match: 'ersatzteil,schlauch', enabled: true },
          { id: 'zubehoer', label: 'Zubehoer', match: 'plane,spriegel,zubehoer', enabled: true }
        ]
      }
    }
  });

  assert.equal(result.priced.kalkulation_anfrage.gesamt_angebot_brutto, 12840);
  assert.equal(result.priced.kalkulation_anfrage.positionen[0].kategorie, 'anhaenger');
  assert.equal(result.priced.kalkulation_anfrage.positionen[0].discount_percent, 5);
  assert.equal(result.priced.kalkulation_anfrage.positionen[1].kategorie, 'ersatzteile');
  assert.equal(result.priced.kalkulation_anfrage.positionen[1].discount_percent, 40);
  assert.equal(result.priced.kalkulation_anfrage.positionen[2].kategorie, 'zubehoer');
  assert.equal(result.priced.kalkulation_anfrage.positionen[2].discount_percent, 10);
});

test('classifies real proof product names into trailer spare part and accessory groups', () => {
  const pricing = {
    productGroups: [
      { id: 'anhaenger', label: 'Anhaenger', match: 'anhaenger,hochlader,kipper,autotransporter,flatbed', enabled: true },
      { id: 'ersatzteile', label: 'Ersatzteile', match: 'ersatzteil,ersatzteile,spare part,spare parts', enabled: true },
      { id: 'zubehoer', label: 'Zubehoer', match: 'zubehoer,plane,spriegel,coc,typisierung,service,rampen,stossdaempfer,shock absorbers,stuetzfuesse,supports,aufsatzbordwaende,bodenunterstuetzung,h-gestelle,led,beleuchtung,lighting,aspoeck', enabled: true }
    ]
  };

  assert.equal(resolveProductCategory('4020 -BT- Flatbed, ramps, without sides -2000kg- Lh: 56cm -195/55R10', pricing), 'anhaenger');
  assert.equal(resolveProductCategory('Aspoeck LED-Beleuchtung', pricing), 'zubehoer');
  assert.equal(resolveProductCategory('Hydraulik Schlauch Ersatzteil', pricing), 'ersatzteile');
});

test('applies inventory EK markup rules for matching stock offers', () => {
  const input = {
    line_items: [{ produkt_name_original: 'Autotransporter 4022 3500kg', preis_mail_brutto_num: 6900 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    Lager: '1',
    'Art.-Nr.': '4022-4-AO3-3563-J',
    'Art.-Bez.': 'Autotransporter 406x220x30 3500kg H=63cm Rampen HP',
    Lagermenge: '1',
    Lagerwert: '1000,00',
    Laenge: '4060',
    Breite: '2200',
    hzGGew: '3500'
  }];

  const result = matchInventory(input, lager, [], {
    pricing: {
      roundTo: 1,
      vatRate: 0.2,
      rules: [
        { match: 'Autotransporter', category: 'anhaenger', source: 'ek_markup', percent: 25, enabled: true }
      ]
    }
  });

  assert.equal(result.kalkulation_lager.gesamt_angebot_brutto, 1500);
  assert.equal(result.kalkulation_lager.price_source, 'lagerwert_ek_markup');
  assert.equal(result.kalkulation_lager.applied_rules[0].type, 'ek_markup');
});

test('flags inventory prices that would show a negative discount', () => {
  const input = {
    line_items: [{ produkt_name_original: 'Autotransporter 4022 3500kg', preis_mail_brutto_num: 6900 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    Lager: '1',
    'Art.-Nr.': '4022-4-AO3-3563-J',
    'Art.-Bez.': 'Autotransporter 406x220x30 3500kg H=63cm Rampen HP',
    Lagermenge: '1',
    Lagerwert: '1001,00',
    Laenge: '4060',
    Breite: '2200',
    hzGGew: '3500'
  }];

  const result = matchInventory(input, lager, [], {
    pricing: {
      roundTo: 10,
      vatRate: 0.2,
      rules: [
        { match: 'Autotransporter', category: 'anhaenger', source: 'ek_markup', percent: 25, enabled: true }
      ]
    }
  });

  assert.equal(result.kalkulation_lager.warnings.some((warning) => warning.code === 'negative_discount'), true);
});

test('matches compatible inventory by type dimensions and weight', () => {
  const input = {
    line_items: [{ produkt_name_original: 'Eduard Hochlader 3318 3500kg', preis_mail_brutto_num: 3000 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    'Art.-Bez.': 'Eduard Hochlader 330x180',
    'Art.-Nr.': '3318-4-303-3563',
    'verf. Lagermenge': '1',
    'Länge': '3300',
    Breite: '1800',
    hzGGew: '3500',
    Lagerwert: '2500'
  }];

  const result = matchInventory(input, lager, []);
  assert.equal(result.hat_match, true);
  assert.equal(result.upsell_daten[0].top_upsell.score, 2100);
  assert.equal(result.upsell_daten[0].top_upsell._match.confidence, 'high');
  assert.equal(result.upsell_daten[0].top_upsell._match.requested_length, 3300);
  assert.equal(result.upsell_daten[0].top_upsell._match.matched_length, 3300);
  assert.equal(result.upsell_daten[0].top_upsell._match.stock_qty, 1);
  assert.equal(result.upsell_daten[0].top_upsell._match.reasons.some((reason) => reason.code === 'length_exact'), true);
  assert.deepEqual(result.upsell_daten[0].top_upsell._match.warnings, []);
});

test('allows safe wider stock alternative when type length and weight are compatible', () => {
  const input = {
    line_items: [{ produkt_name_original: '3116 -GD- Hochlader, Bordwände 30cm -2000kg- Lfh: 63cm', preis_mail_brutto_num: 2675 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    'Art.-Bez.': 'Hochlader 311x180x30 2000kg H=63cm',
    'Art.-Nr.': '3118-4-P3-2063',
    Lagermenge: '1',
    Lagerwert: '2500',
    'Länge': '3110',
    Breite: '1800',
    hzGGew: '2000'
  }];

  const result = matchInventory(input, lager, []);
  assert.equal(result.hat_match, true);
  assert.equal(result.upsell_daten[0].top_upsell.score, 1050);
  assert.equal(result.upsell_daten[0].top_upsell._match.confidence, 'medium');
  assert.equal(result.upsell_daten[0].top_upsell._match.reasons.some((reason) => reason.code === 'width_close'), true);
});

test('keeps lower-weight or large-dimension alternatives weak', () => {
  const input = {
    line_items: [{ produkt_name_original: '3116 -GD- Hochlader, Bordwände 30cm -2700kg- Lfh: 56cm', preis_mail_brutto_num: 3000 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    'Art.-Bez.': 'Hochlader 311x180x30 2000kg H=63cm',
    'Art.-Nr.': '3118-4-P3-2063',
    Lagermenge: '1',
    Lagerwert: '2500',
    'Länge': '3110',
    Breite: '1800',
    hzGGew: '2000'
  }];

  const result = matchInventory(input, lager, []);
  assert.equal(result.hat_match, true);
  assert.equal(result.upsell_daten[0].top_upsell.score < 1000, true);
  assert.equal(result.upsell_daten[0].top_upsell._match.confidence, 'low');
  assert.equal(result.upsell_daten[0].top_upsell._match.warnings.some((warning) => warning.code === 'weight_mismatch'), true);
});

test('allows close higher-weight stock alternative without allowing large length mismatch', () => {
  const input = {
    line_items: [{ produkt_name_original: '3116 -GD- Heckkipper, Bordwände 30cm -2700kg- E-Pumpe - Lfh: 63cm', preis_mail_brutto_num: 4483.33 }],
    kalkulation_anfrage: {}
  };
  const lager = [
    {
      'Art.-Bez.': 'Rückwärtskipper mit Rampen 311x180x30 3000kg H=63cm EP+N',
      'Art.-Nr.': '3118-4-13-3063-N',
      Lagermenge: '1',
      Lagerwert: '3900',
      'Länge': '3110',
      Breite: '1800',
      hzGGew: '3000'
    },
    {
      'Art.-Bez.': 'Rückwärtskipper 256x150x30 2700kg H=63cm EP+N',
      'Art.-Nr.': '2515-4-13-2763-N',
      Lagermenge: '1',
      Lagerwert: '3500',
      'Länge': '2560',
      Breite: '1500',
      hzGGew: '2700'
    }
  ];

  const result = matchInventory(input, lager, []);
  assert.equal(result.hat_match, true);
  assert.equal(result.upsell_daten[0].top_upsell['Art.-Nr.'], '3118-4-13-3063-N');
  assert.equal(result.upsell_daten[0].top_upsell.score, 1000);
  assert.equal(result.upsell_daten[0].top_upsell._match.confidence, 'medium');
});

test('extracts Eduard article numbers and prefers exact stock article match', () => {
  const inquiry = extractInquiry({
    text: [
      'Vorname         Thomas',
      'Nachname        Pollak',
      'E-mail-Adresse  pollak-thomas@gmx.net',
      'Konfiguration   Konfiguration anschauen<https://www.anhaenger-eduard.at/configurator/aa8bb8d3-ff2c-4ad5-a3d6-6f36adc4749f>',
      '3116 -GD- Heckkipper, Bordwände 30cm -2700kg- E-Pumpe - Lfh: 63cm -195/50R13    € 4.437,50',
      'COC     € 12,50',
      'Typisierung     € 33,33',
      'Preis   € 4.483,33',
      'MwSt    20%',
      'Preis inkl. MwSt        € 5.380,00',
      '',
      'Artikelnummern Anhänger und Zubehör',
      '*   3116-4-13-2763-N'
    ].join('\n')
  });
  const priced = calculateInquiryOffer(inquiry);
  const lager = [
    {
      'Art.-Nr.': '3118-4-1O3-3072-P',
      'Art.-Bez.': 'Rückwärtskipper 311x180x30 3000kg H=72cm Rampen EP+N',
      Lagermenge: '1',
      Lagerwert: '4500',
      'Länge': '3110',
      Breite: '1800',
      hzGGew: '3000'
    },
    {
      'Art.-Nr.': '3116-4-13-2763-N',
      'Art.-Bez.': 'Rückwärtskipper 310x160x30 2700kg H=63cm EP+N',
      Lagermenge: '1',
      Lagerwert: '3900',
      'Länge': '3100',
      Breite: '1600',
      hzGGew: '2700'
    }
  ];

  assert.equal(inquiry.line_items[0].artikelnummer, '3116-4-13-2763-N');
  const result = matchInventory(priced, lager, []);
  assert.equal(result.top_lager_name, 'Rückwärtskipper 310x160x30 2700kg H=63cm EP+N');
  assert.ok(result.upsell_daten[0].top_upsell.score >= 5000);
});

test('matches sheet inventory rows with Lager and serial number columns', () => {
  const input = {
    line_items: [{ produkt_name_original: 'Autotransporter 4022 3500kg', preis_mail_brutto_num: 6900 }],
    kalkulation_anfrage: {}
  };
  const lager = [{
    Lager: '1',
    'Art.-Nr.': '4022-4-AO3-3563-J',
    'Art.-Bez.': 'Autotransporter 406x220x30 3500kg H=63cm Rampen HP',
    'Ser.-Nr. (int)': 'YCE40224702611471',
    Lagermenge: '1',
    Lagerwert: '6924,99',
    'Länge': '4060',
    Breite: '2200',
    hzGGew: '3500'
  }];

  const result = matchInventory(input, lager, lager);
  assert.equal(result.hat_match, true);
  assert.equal(result.upsell_daten[0].top_upsell['Ser.-Nr. (int)'], 'YCE40224702611471');
  assert.match(result.kalkulation_lager.positionen[0].produkt_name, /Autotransporter/);
});

test('normalizes German trailer type names', () => {
  assert.equal(getTrailerType('Rückwärtskipper 2615'), 'rueckwaertskipper');
  assert.equal(getTrailerType('Dreiseitenkipper 3318'), 'dreiseitenkipper');
});

test('runs full workflow and returns offer email payload', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    text: [
      'Vorname  Max',
      'Nachname  Mustermann',
      'E-mail-Adresse  max@example.com',
      'Hochlader 3318 3500kg  € 3.000,00'
    ].join('\n')
  });

  assert.equal(result.offer.email, 'max@example.com');
  assert.match(result.offer.html_angebot, /Ihr|Eduard|Anhänger/);
});

test('separates trailer and accessories in the offer table', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
        <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
        <tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        <tr><td>Plane und Spriegel</td><td>&euro; 500,00</td></tr>
      </table>`
  });

  assert.match(result.offer.html_angebot, /Anhänger/);
  assert.match(result.offer.html_angebot, /Zubehör/);
});

test('adds dynamic n8n hint texts for configured accessories and trailer risks', () => {
  const result = runWorkflow({
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
        <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
        <tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>
        <tr><td>Rückwärtskipper 3318 3500kg elektrisch E-Pumpe LED</td><td>&euro; 3.000,00</td></tr>
        <tr><td>Plane und Spriegel</td><td>&euro; 500,00</td></tr>
      </table>`
  });

  assert.match(result.offer.html_angebot, /Hinweis LED-Beleuchtung/);
  assert.match(result.offer.html_angebot, /Hinweis Montagekosten für Zubehöre/);
  assert.match(result.offer.html_angebot, /Hinweis Elektropumpe/);
  assert.match(result.offer.html_angebot, /Hinweis Heckstützen/);
});

test('renders translated customer offer templates for scenarios A B C in DE NL CZ', () => {
  const expectations = {
    de: {
      subject: 'Ihr Eduard Angebot',
      greeting: 'Sehr geehrte/r',
      intro: 'vielen Dank',
      desired: 'Ihre Wunsch-Konfiguration',
      stock: 'Sofort ab Lager',
      alternative: 'Alternativ steht',
      position: 'Position',
      total: 'Gesamt',
      regards: 'Beste Gr'
    },
    nl: {
      subject: 'Uw Eduard offerte',
      greeting: 'Geachte',
      intro: 'bedankt voor uw aanvraag',
      desired: 'Uw gewenste configuratie',
      stock: 'Direct uit voorraad',
      alternative: 'Als alternatief',
      position: 'Positie',
      total: 'Totaal',
      regards: 'Met vriendelijke groet'
    },
    cs: {
      subject: 'Va\u0161e nab\u00eddka Eduard',
      greeting: 'V\u00e1\u017een\u00fd z\u00e1kazn\u00edku',
      intro: 'd\u011bkujeme za va\u0161i popt\u00e1vku',
      desired: 'Va\u0161e po\u017eadovan\u00e1 konfigurace',
      stock: 'Ihned k dispozici ze skladu',
      alternative: 'Alternativn\u011b',
      position: 'Polo\u017eka',
      total: 'Celkem',
      regards: 'S pozdravem'
    }
  };

  for (const language of ['de', 'nl', 'cs']) {
    for (const scenario of ['A', 'B', 'C']) {
      const offer = buildOfferEmail(templateScenario(scenario, language));
      const expected = expectations[language];

      assert.match(offer.betreff, new RegExp(expected.subject), `${language} ${scenario} subject`);
      assert.match(offer.html_angebot, new RegExp(expected.greeting), `${language} ${scenario} greeting`);
      assert.match(offer.html_angebot, new RegExp(expected.intro), `${language} ${scenario} intro`);
      assert.match(offer.html_angebot, new RegExp(expected.position), `${language} ${scenario} position`);
      assert.match(offer.html_angebot, new RegExp(expected.total), `${language} ${scenario} total`);
      assert.match(offer.html_angebot, new RegExp(expected.regards), `${language} ${scenario} regards`);

      if (scenario === 'A' || scenario === 'C') {
        assert.match(offer.html_angebot, new RegExp(expected.desired), `${language} ${scenario} desired`);
      }
      if (scenario === 'B' || scenario === 'C') {
        assert.match(offer.html_angebot, new RegExp(expected.stock), `${language} ${scenario} stock`);
      }
      if (scenario === 'C') {
        assert.match(offer.html_angebot, new RegExp(expected.alternative), `${language} ${scenario} alternative`);
      }
    }
  }
});

function templateScenario(scenario, inputLanguage) {
  const base = {
    input_language: inputLanguage,
    kunde_vorname: 'Alex',
    kunde_nachname: 'Customer',
    kunde_email: 'alex@example.com',
    line_items: [{ produkt_name_original: 'Hochlader 3318 3500kg' }],
    kalkulation_anfrage: {
      gesamt_uvp_brutto: 3600,
      gesamt_angebot_brutto: 3140,
      gesamt_rabatt_brutto: 460,
      positionen: [
        { produkt_name: 'Hochlader 3318 3500kg', kategorie: 'anhaenger', uvp_netto: 3000, angebot_netto: 2616.67 }
      ]
    },
    upsell_daten: []
  };

  if (scenario === 'A') return { ...base, hat_match: false };

  const stock = {
    gesamt_uvp_brutto: 5990,
    gesamt_angebot_brutto: 5220,
    gesamt_rabatt_brutto: 770,
    positionen: [
      { produkt_name: 'Hochlader 3318 Lager', kategorie: 'anhaenger', uvp_netto: 4991.67, angebot_netto: 4350 }
    ]
  };
  return {
    ...base,
    hat_match: true,
    top_lager_name: 'Eduard Hochlader Lager',
    kalkulation_lager: stock,
    upsell_daten: [{
      angefragt: scenario === 'B' ? '3318-4-PB30-3563 Hochlader 3318 3500kg' : 'Hochlader 3318 3500kg',
      top_upsell: { 'Art.-Nr.': scenario === 'B' ? '3318-4-PB30-3563' : '3318-4-PB30-3563-X' }
    }]
  };
}

test('reads semicolon separated CSV objects for local uploads', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-')), 'lager.csv');
  await fs.writeFile(file, 'Produktcode;Bruttopreis (Konfigurator);Typ\nABC-1;"3.000,00";Hochlader\n', 'utf8');

  const rows = await readCsvObjects(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Produktcode, 'ABC-1');
  assert.equal(rows[0]['Bruttopreis (Konfigurator)'], '3.000,00');
});

test('reads Windows-1252 CSV exports without breaking German umlauts', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-cp1252-')), 'lager.csv');
  const csv = 'Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert\nABC-1;Rückwärtskipper Größe Zubehör;1;3000\n';
  await fs.writeFile(file, Buffer.from(csv, 'latin1'));

  const rows = await readCsvObjects(file);
  assert.equal(rows[0]['Art.-Bez.'], 'Rückwärtskipper Größe Zubehör');
  assert.equal(decodeCsvBuffer(Buffer.from(csv, 'latin1')), csv);
});

test('atomic file write keeps original inventory when temp write fails before rename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-atomic-write-'));
  const file = path.join(dir, 'lager.csv');
  await fs.writeFile(file, 'Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert\nOLD;Alt;1;1000\n', 'utf8');

  await assert.rejects(
    atomicWriteFile(file, 'Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert\nNEW;Neu;1;2000\n', {
      writeFile: async () => {
        throw new Error('simulated_mid_write_crash');
      }
    }),
    /simulated_mid_write_crash/
  );

  assert.equal(await fs.readFile(file, 'utf8'), 'Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert\nOLD;Alt;1;1000\n');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['lager.csv']);
});

test('validates inventory CSV before upload can mark inventory connected', () => {
  const valid = validateInventoryCsv([
    'Lager;Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert;Länge;Breite;hzGGew',
    '1;4022-4-AO3-3563-J;Autotransporter 406x220x30 3500kg;1;6924,99;4060;2200;3500'
  ].join('\n'));
  assert.equal(valid.ok, true);
  assert.equal(valid.stats.rows, 1);

  const missingSku = validateInventoryCsv('Art.-Bez.;Lagermenge;Lagerwert\nHochlader;1;3000');
  assert.equal(missingSku.ok, false);
  assert.equal(missingSku.errors.some((error) => error.code === 'missing_sku'), true);

  const duplicateSkuDifferentSerial = validateInventoryCsv([
    'Art.-Nr.;Art.-Bez.;Ser.-Nr. (int);Lagermenge;Lagerwert',
    'ABC-1;Hochlader;VIN-1;1;3000',
    'ABC-1;Hochlader zweiter;VIN-2;1;3500'
  ].join('\n'));
  assert.equal(duplicateSkuDifferentSerial.ok, true);

  const duplicateVehicle = validateInventoryCsv([
    'Art.-Nr.;Art.-Bez.;Ser.-Nr. (int);Lagermenge;Lagerwert',
    'ABC-1;Hochlader;VIN-1;1;3000',
    'ABC-1;Hochlader zweiter;VIN-1;1;3500'
  ].join('\n'));
  assert.equal(duplicateVehicle.ok, false);
  assert.equal(duplicateVehicle.errors.some((error) => error.code === 'duplicate_vehicle'), true);

  const badNumber = validateInventoryCsv('Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert\nABC-1;Hochlader;viel;3000');
  assert.equal(badNumber.ok, false);
  assert.equal(badNumber.errors.some((error) => error.code === 'invalid_stock'), true);
});

test('builds setup checklist and offer record for admin console', async () => {
  const result = runWorkflow({
    id: 'msg-1',
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
        <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
        <tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
      </table>`
  });
  const record = await appendOfferRecord(result, { messageId: 'msg-1', subject: 'Eduard Anfrage', mode: 'test' });
  const checklist = getOnboardingChecklist(
    { onboarding: { googleConnected: true, inventoryConnected: true } },
    {
      signature: { company: 'Daltec GmbH', name: 'Lukas', email: 'lukas@daltec.at' },
      pricing: { offerFactor: 0.87, vatRate: 0.2 },
      mail: { to: 'michael@daltec.at', subject: 'Daltec Eduard Angebot' }
    },
    { lagerCsvExists: true }
  );

  assert.equal(record.customer.email, 'max@example.com');
  assert.equal(record.offer.totalGross, 3140);
  assert.equal(checklist.every((item) => item.done), true);
});

test('keeps tenant settings and offer history separated', async () => {
  const tenantA = tenantContext({ tenantId: `test-a-${Date.now()}` });
  const tenantB = tenantContext({ tenantId: `test-b-${Date.now()}` });

  await saveSettings({ mail: { subject: 'Tenant A Angebot' } }, tenantA);
  await saveSettings({ mail: { subject: 'Tenant B Angebot' } }, tenantB);

  const settingsA = await loadSettings(tenantA);
  const settingsB = await loadSettings(tenantB);
  assert.equal(settingsA.mail.subject, 'Tenant A Angebot');
  assert.equal(settingsB.mail.subject, 'Tenant B Angebot');

  const result = runWorkflow({
    id: 'msg-tenant',
    subject: 'Eduard Anfrage',
    html: `
      <table>
        <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
        <tr><td><strong>Nachname</strong></td><td>Tenant</td></tr>
        <tr><td><strong>E-mail-Adresse</strong></td><td>tenant@example.com</td></tr>
        <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
      </table>`
  });
  await appendOfferRecord(result, { messageId: 'a-1', subject: 'A', mode: 'test' }, tenantA);

  const offersA = await listOfferRecords(10, tenantA);
  const offersB = await listOfferRecords(10, tenantB);
  assert.equal(offersA.length, 1);
  assert.equal(offersA[0].tenantId, tenantA.tenantId);
  assert.equal(offersB.length, 0);
});

test('deduplicates forwarded Eduard leads by configurator fingerprint', async () => {
  const context = tenantContext({ tenantId: `test-dedupe-${Date.now()}` });
  const leadText = [
    'Vorname         Max',
    'Nachname        Duplikat',
    'E-mail-Adresse  max@example.com',
    'Konfiguration   Konfiguration anschauen<https://www.anhaenger-eduard.at/configurator/4be5e62b-5091-4b42-a95f-4bf2d97dca7e>',
    '3518 -GD- Hochlader, Bordwände 30cm -2000kg- Lfh: 56cm -195/55R10       € 3.008,33',
    'Artikelnummern Anhänger und Zubehör',
    '*   3518-4-P3-2056'
  ].join('\n');

  const first = await ingestInboundMessage({
    provider: 'gmail',
    provider_message_id: 'gmail-message-1',
    subject: 'WG: Neuer Lead – Angebot via EDUARD-Konfigurator',
    from_email: 'office@dealer.example',
    raw_text: leadText
  }, context);
  const second = await ingestInboundMessage({
    provider: 'gmail',
    provider_message_id: 'gmail-message-2',
    subject: 'Fw: Neuer Lead – Angebot via EDUARD-Konfigurator',
    from_email: 'office@dealer.example',
    raw_text: leadText
  }, context);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.run.id, first.run.id);

  const parsed = extractInquiry({ text: leadText });
  assert.equal(parsed.line_items[0].preis_mail_brutto_num, 3008.33);
  assert.equal(parsed.line_items.some((item) => /Preis inkl/i.test(item.produkt_name_original)), false);
  const fallbackParsed = extractInquiry({ text: leadText.replaceAll('€', '?') });
  assert.equal(fallbackParsed.line_items[0].preis_mail_brutto_num, 3008.33);
});

test('deduplicates forwarded Eduard leads by customer and priced product when article number is missing', async () => {
  const context = tenantContext({ tenantId: `test-dedupe-priced-${Date.now()}` });
  const leadText = [
    'Vorname         H.',
    'Nachname        Keller',
    'E-mail-Adresse  HA1KA1H@aon.at',
    '3518 -GD- Hochlader, Bordwände 30cm -2000kg- Lfh: 56cm -195/55R10       € 3.008,33',
    'COC       € 12,50',
    'Typisierung       € 33,33'
  ].join('\n');

  const first = await ingestInboundMessage({
    provider: 'gmail',
    provider_message_id: 'gmail-priced-1',
    subject: 'Fw: Neuer Lead – Angebot via EDUARD-Konfigurator',
    from_email: 'office@daltec.at',
    raw_text: leadText
  }, context);
  const second = await ingestInboundMessage({
    provider: 'gmail',
    provider_message_id: 'gmail-priced-2',
    subject: 'WG: Neuer Lead – Angebot via EDUARD-Konfigurator',
    from_email: 'office@daltec.at',
    raw_text: leadText
  }, context);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.run.id, first.run.id);
});

test('routes inbound leads to the right tenant by slug, plus alias and sender domain', async () => {
  const stamp = Date.now();
  const explicit = await resolveTenantContextForInbound({ dealerSlug: `haendler-${stamp}` });
  assert.equal(explicit.tenantId, `haendler-${stamp}`);

  const aliasId = `alias-${stamp}`;
  await saveTenant({
    name: 'Alias Dealer',
    routing: {
      recipientEmails: [`angebote+${aliasId}@ventocamp.test`]
    }
  }, tenantContext({ tenantId: aliasId }));
  const alias = await resolveTenantContextForInbound({
    toEmail: `angebote+${aliasId}@ventocamp.test`,
    fromEmail: 'office@unknown.example'
  });
  assert.equal(alias.tenantId, aliasId);

  const domainId = `domain-${stamp}`;
  const domainName = `dealer-routing-${stamp}.example`;
  await saveTenant({
    name: 'Domain Dealer',
    routing: {
      senderDomains: [domainName]
    }
  }, tenantContext({ tenantId: domainId }));
  const domain = await resolveTenantContextForInbound({
    fromEmail: `sales@${domainName}`,
    toEmail: 'angebote@ventocamp.test'
  });
  assert.equal(domain.tenantId, domainId);
});

test('lists tenant contexts for central forwarding and direct mailbox polling', async () => {
  const tenantId = `poll-tenant-${Date.now()}`;
  await saveTenant({ name: 'Polling Dealer' }, tenantContext({ tenantId }));

  const contexts = await listTenantContexts();
  assert.equal(contexts.some((context) => context.tenantId === 'daltec-local'), true);
  assert.equal(contexts.some((context) => context.tenantId === tenantId), true);
});

test('direct tenant mailbox runtime does not fall back to the central legacy Gmail token', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-mail-runtime-'));
  const legacyTokenPath = path.join(dir, 'google-oauth-token.json');
  await fs.writeFile(legacyTokenPath, JSON.stringify({ refresh_token: 'central-token' }), 'utf8');

  await assert.rejects(
    () => createMailRuntime({
      google: {
        oauthClientPath: path.join(dir, 'missing-client.json'),
        oauthTokenPath: legacyTokenPath
      },
      microsoft: {},
      gmail: {}
    }, tenantContext({ tenantId: `direct-mail-${Date.now()}` }), { allowLegacyGoogleToken: false }),
    /Kein Mail-Zugang verbunden/
  );
});

test('detects internal owner drafts before they can be parsed as new Eduard leads', () => {
  assert.equal(isInternalOwnerDraft({
    subject: 'Fwd: Daltec Eduard Angebot',
    fromEmail: 'Luca Schneider <ventocamp@gmail.com>'
  }, {
    gmail: { subject: 'Daltec Eduard Angebot', cc: 'ventocamp@gmail.com' }
  }, {
    mail: { subject: 'Daltec Eduard Angebot' }
  }), true);

  assert.equal(isInternalOwnerDraft({
    subject: 'WG: Neuer Lead Angebot via EDUARD-Konfigurator',
    fromEmail: 'office@dealer.example'
  }, {
    gmail: { subject: 'Daltec Eduard Angebot', cc: 'ventocamp@gmail.com' }
  }, {
    mail: { subject: 'Daltec Eduard Angebot' }
  }), false);
});

test('chooses Gmail labels that preserve review and duplicate outcomes', () => {
  assert.equal(labelForProcessedRun('completed', { status: 'sent_to_owner', error_code: null }), 'Eduard/processed');
  assert.equal(labelForProcessedRun('needs_review', { status: 'sent_to_owner', error_code: 'weak_inventory_match' }), 'Eduard/needs_review');
  assert.equal(labelForProcessedRun('completed', {
    status: 'sent_to_owner',
    events: [{ event_type: 'price_needs_review' }]
  }), 'Eduard/needs_review');
  assert.equal(labelForProcessedRun('failed_retryable', { status: 'failed_retryable' }), 'Eduard/failed');
  assert.equal(labelForIgnoredRun('duplicate'), 'Eduard/duplicate');
  assert.equal(labelForIgnoredRun('internal'), 'Eduard/ignored-internal');
  assert.equal(labelForIgnoredRun('not_eduard'), 'Eduard/ignored');
});

test('replays exported messages and reports duplicates and snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-replay-'));
  const file = path.join(dir, 'messages.json');
  const text = [
    'Vorname Replay',
    'Nachname Tester',
    'E-mail-Adresse replay@example.com',
    'Konfiguration Konfiguration anschauen<https://www.anhaenger-eduard.at/configurator/replay-11111111-2222-4333-8444-555555555555>',
    'Autotransporter 4022 3500kg EUR 6924,99',
    'Artikelnummern Anhänger und Zubehör',
    '* 4022-4-AO3-3563-J'
  ].join('\n');
  await fs.writeFile(file, JSON.stringify([
    {
      id: `replay-${Date.now()}-1`,
      subject: 'Eduard Anfrage Replay',
      from: 'kunde@example.com',
      text
    },
    {
      id: `replay-${Date.now()}-2`,
      subject: 'Eduard Anfrage Replay',
      from: 'kunde@example.com',
      text
    }
  ]), 'utf8');

  const report = await replayMessages(file, {
    tenantId: `replay-test-${Date.now()}`,
    provider: 'replay_test',
    prefix: `replay-test-${Date.now()}`
  });

  assert.equal(report.total, 2);
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.results[0].hasPricingSnapshot, true);
  assert.equal(report.results[0].hasMatchSnapshot, true);
  assert.equal(report.dangerousCount, 0);
  assert.equal(report.proof.readyForDaltecDailyUse, false);
  assert.equal(report.proof.duplicateCount, 1);
  assert.equal(report.proof.blockers.some((blocker) => blocker.code === 'proof_mail_count_low'), true);
});

test('proof gate counts controlled review drafts without counting hard failures as safe', () => {
  const report = buildReplayReport([
    {
      status: 'sent_to_owner',
      duplicate: false,
      dangerous: false,
      hasDraft: true,
      hasPricingSnapshot: true,
      hasMatchSnapshot: true
    },
    {
      status: 'needs_review',
      duplicate: false,
      dangerous: false,
      errorCode: 'weak_inventory_match',
      hasDraft: true,
      hasPricingSnapshot: true,
      hasMatchSnapshot: true
    },
    {
      status: 'needs_review',
      duplicate: false,
      dangerous: false,
      errorCode: 'unsupported_currency',
      hasDraft: true,
      hasPricingSnapshot: false,
      hasMatchSnapshot: true
    },
    {
      status: 'duplicate',
      duplicate: true,
      dangerous: false
    }
  ], {
    targetTotal: 4,
    inventory: { itemCount: 20, minItemCount: 15 }
  });

  assert.equal(report.proof.uniqueCount, 3);
  assert.equal(report.proof.completedRate, 0.33);
  assert.equal(report.proof.safeDraftCandidateCount, 2);
  assert.equal(report.proof.safeDraftCandidateRate, 0.67);
  assert.equal(report.proof.blockers.some((blocker) => blocker.code === 'safe_draft_candidate_rate_low'), true);
});

test('replay can seed an isolated proof tenant from a production tenant', async () => {
  const sourceTenantId = `source-proof-${Date.now()}`;
  const targetTenantId = `target-proof-${Date.now()}`;
  const sourceContext = tenantContext({ tenantId: sourceTenantId });
  const targetContext = tenantContext({ tenantId: targetTenantId });

  await saveTenant({ name: 'DALTEC Source' }, sourceContext);
  await saveSettings({
    pricing: { categoryDiscounts: { anhaenger: 13, zubehoer: 9 } },
    data: { inventoryMaxAgeHours: 24 }
  }, sourceContext);
  await fs.writeFile(sourceContext.inventoryPath, [
    'Lager;Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert;Länge;Breite;hzGGew',
    '1;4022-4-AO3-3563-J;Autotransporter 406x220x30 3500kg;1;6924,99;4060;2200;3500'
  ].join('\n'), 'utf8');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eduard-replay-seed-'));
  const file = path.join(dir, 'messages.json');
  await fs.writeFile(file, JSON.stringify([{
    id: `seeded-replay-${Date.now()}`,
    subject: 'Eduard Anfrage Proof',
    from: 'kunde@example.com',
    text: [
      'Vorname Proof',
      'Nachname Kunde',
      'E-mail-Adresse proof@example.com',
      'Autotransporter 4022 3500kg EUR 6924,99',
      '* 4022-4-AO3-3563-J'
    ].join('\n')
  }]), 'utf8');

  const report = await replayMessages(file, {
    tenantId: targetTenantId,
    sourceTenantId,
    provider: 'replay_test',
    prefix: `seeded-replay-${Date.now()}`
  });
  const targetSettings = await loadSettings(targetContext);

  assert.equal(report.seeded.sourceTenantId, sourceTenantId);
  assert.equal(report.seeded.targetTenantId, targetTenantId);
  assert.equal(report.seeded.settingsCopied, true);
  assert.equal(report.seeded.inventoryCopied, true);
  assert.equal(report.seeded.inventoryItemCount, 1);
  assert.equal(report.proof.inventoryItemCount, 1);
  assert.equal(report.proof.blockers.some((blocker) => blocker.code === 'inventory_too_small'), true);
  assert.equal(report.proof.nextAction, 'Vollstaendige Lager-/Preis-CSV hochladen und Proof erneut laufen lassen.');
  assert.equal(targetSettings.data.lagerCsvPath, targetContext.inventoryPath);
  assert.equal(report.dangerousCount, 0);
});

test('builds read-only Gmail export query without internal owner drafts', () => {
  const query = defaultExportQuery({
    gmail: {
      subjectFilter: 'Eduard',
      subject: 'Daltec Eduard Angebot',
      cc: 'ventocamp@gmail.com'
    }
  });
  assert.match(query, /subject:Eduard/);
  assert.match(query, /-subject:"Daltec Eduard Angebot"/);
  assert.match(query, /-from:ventocamp@gmail\.com/);
  assert.equal(query.includes('is:unread'), false);
});

test('builds Gmail unread poll query from the same sender filter shown in setup', () => {
  const query = buildUnreadQuery({
    gmail: {
      senderQuery: 'office',
      subjectFilter: 'Eduard',
      subject: 'Daltec Eduard Angebot',
      cc: 'ventocamp@gmail.com'
    }
  });

  assert.match(query, /is:unread/);
  assert.match(query, /from:office/);
  assert.match(query, /subject:Eduard/);
  assert.match(query, /-subject:"Daltec Eduard Angebot"/);
  assert.match(query, /-from:ventocamp@gmail\.com/);
});

test('proof Gmail export rejects internal owner and review digest mails', () => {
  const config = {
    gmail: {
      subjectFilter: 'Eduard',
      subject: 'Daltec Eduard Angebot',
      cc: 'ventocamp@gmail.com'
    }
  };

  assert.equal(isProofCandidate({
    subject: 'Eduard Review Queue: 17 offene Bewertungen',
    from: '',
    text: 'Bitte bewerten'
  }, config), false);

  assert.equal(isProofCandidate({
    subject: 'Daltec Eduard Angebot',
    from: 'Luca Schneider <ventocamp@gmail.com>',
    text: 'Sehr geehrter Kunde, vielen Dank fuer Ihre Anfrage.'
  }, config), false);

  assert.equal(isProofCandidate({
    subject: 'WG: Neuer Lead Angebot via EDUARD-Konfigurator',
    from: 'office@dealer.example',
    text: [
      'Vorname Max',
      'Nachname Mustermann',
      'E-mail-Adresse max@example.com',
      'Konfiguration anschauen https://www.anhaenger-eduard.at/configurator/aa8bb8d3-ff2c-4ad5-a3d6-6f36adc4749f',
      'Hochlader 3318 3500kg EUR 3.000,00'
    ].join('\n')
  }, config), true);
});

test('imports dealer inventory CSV attachments with automatic column mapping', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-import-'));
  const context = {
    tenantId: 'inventory-import-test',
    baseDir: dir,
    tenantPath: path.join(dir, 'tenant.json'),
    settingsPath: path.join(dir, 'settings.json'),
    offersPath: path.join(dir, 'offers.jsonl'),
    inventoryPath: path.join(dir, 'lager.csv'),
    mailConnectionsPath: path.join(dir, 'mail-connections.json')
  };
  const csv = [
    'Artikelnummer;Beschreibung;Bestand;EK;Laenge;Breite;Gewicht',
    '3318-4-13-3563-N;Hochlader 330x180 3500kg;1;3900;3300;1800;3500'
  ].join('\n');
  const message = {
    id: 'inventory-1',
    subject: 'Lagerliste Eduard',
    from: 'haendler@example.com',
    to: 'lager@example.com',
    attachments: [{ filename: 'lager.csv', data: Buffer.from(csv, 'utf8') }]
  };

  assert.equal(isInventoryImportMessage(message), true);
  const result = await processInventoryImportMessage(message, { data: { lagerCsvPath: context.inventoryPath } }, context);
  assert.equal(result.ok, true);
  const written = await fs.readFile(context.inventoryPath, 'utf8');
  assert.match(written, /Art\.-Nr\.;Art\.-Bez\.;Lagermenge;Lagerwert;Länge;Breite;hzGGew/);
  assert.match(written, /3318-4-13-3563-N;Hochlader 330x180 3500kg;1;3900;3300;1800;3500/);
  const imports = await listInventoryImports(5, context);
  assert.equal(imports[0].status, 'success');
  assert.equal(imports[0].rowCount, 1);
});

test('imports dealer inventory XLSX attachments with automatic column mapping', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-import-xlsx-'));
  const context = {
    tenantId: 'inventory-import-xlsx-test',
    baseDir: dir,
    tenantPath: path.join(dir, 'tenant.json'),
    settingsPath: path.join(dir, 'settings.json'),
    offersPath: path.join(dir, 'offers.jsonl'),
    inventoryPath: path.join(dir, 'lager.csv'),
    mailConnectionsPath: path.join(dir, 'mail-connections.json')
  };
  const buffer = buildMinimalXlsx([
    ['SKU', 'Name', 'Stock', 'Price', 'Length', 'Width', 'KG'],
    ['4020-4-AO3-3563-J', 'Autotransporter 406x200 3500kg', 1, 6900, 4060, 2000, 3500]
  ]);

  const result = await processInventoryImportMessage({
    id: 'inventory-2',
    subject: 'stock export',
    from: 'dealer@example.com',
    attachments: [{ filename: 'stock.xlsx', data: buffer }]
  }, { data: { lagerCsvPath: context.inventoryPath } }, context);

  assert.equal(result.ok, true);
  const written = await fs.readFile(context.inventoryPath, 'utf8');
  assert.match(written, /4020-4-AO3-3563-J;Autotransporter 406x200 3500kg;1;6900;4060;2000;3500/);
});

test('marks inventory import when failure reply mail cannot be sent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-import-reply-failed-'));
  const context = {
    tenantId: 'inventory-import-reply-failed-test',
    baseDir: dir,
    tenantPath: path.join(dir, 'tenant.json'),
    settingsPath: path.join(dir, 'settings.json'),
    offersPath: path.join(dir, 'offers.jsonl'),
    inventoryPath: path.join(dir, 'lager.csv'),
    mailConnectionsPath: path.join(dir, 'mail-connections.json')
  };
  const message = {
    id: 'inventory-reply-failed-1',
    subject: 'Lagerliste Eduard',
    from: 'Haendler <haendler@example.com>',
    to: 'lager@example.com',
    attachments: [{ filename: 'lager.csv', data: Buffer.from('Artikelnummer;Beschreibung\n3318-4-13-3563-N;Hochlader', 'utf8') }]
  };
  const mailRuntime = {
    provider: 'gmail',
    client: {},
    sendHtmlMail: async () => {
      throw new Error('SMTP unavailable');
    },
    labelMessage: async () => {},
    markMessageRead: async () => {}
  };

  await processMailMessage(
    message,
    mailRuntime,
    { gmail: { to: 'admin@example.com' } },
    { data: { lagerCsvPath: context.inventoryPath }, mail: { to: 'admin@example.com' } },
    { forcedTenantContext: context }
  );

  const imports = await listInventoryImports(5, context);
  assert.equal(imports[0].status, 'failed');
  assert.equal(imports[0].replyMailFailed, true);
});

function buildMinimalXlsx(rows) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Lager" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, cellIndex) => xlsxCell(cell, rowIndex + 1, cellIndex + 1)).join('')}</row>`).join('')}</sheetData>
      </worksheet>`
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))));
}

function xlsxCell(value, row, col) {
  const ref = `${columnName(col)}${row}`;
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function columnName(index) {
  let value = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    index = Math.floor((index - 1) / 26);
  }
  return value;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
