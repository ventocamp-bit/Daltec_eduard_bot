const panels = [...document.querySelectorAll('[data-panel]')];
const tabs = [...document.querySelectorAll('[data-step]')];
const dealerForm = document.querySelector('#dealer-form');
const saveDealerButton = document.querySelector('#save-dealer');
const uploadButton = document.querySelector('#upload-csv');
const uploadInput = document.querySelector('#csv-file');
const uploadStatus = document.querySelector('#upload-status');
const csvErrors = document.querySelector('#csv-errors');
const sampleCsvDownload = document.querySelector('#sample-csv-download');
const pageStatus = document.querySelector('#onboarding-status');
const mailChecks = document.querySelector('#mail-checks');
const finalChecks = document.querySelector('#final-checks');
const refreshButton = document.querySelector('#refresh-status');
const simulateTestRunButton = document.querySelector('#simulate-test-run');
const mailTabs = [...document.querySelectorAll('[data-mail-tab]')];
const mailPanels = [...document.querySelectorAll('[data-mail-panel]')];
const imapForm = document.querySelector('#imap-form');
const connectImapButton = document.querySelector('#connect-imap');
const imapResult = document.querySelector('#imap-result');

const CSV_HEADER_ALIASES = {
  sku: ['Art.-Nr.', 'Artikelnummer', 'Produktcode'],
  name: ['Art.-Bez.', 'Artikelbezeichnung', 'Bezeichnung', 'Typ'],
  stock: ['Lagermenge', 'verf. Lagermenge', 'Lager'],
  stockValue: ['Lagerwert', 'EK', 'Einkaufspreis', 'Bruttopreis (Konfigurator)']
};
const CSV_REQUIRED_FIELDS = ['sku', 'name', 'stock', 'stockValue'];

let currentStep = 0;
let tenant = null;
let checklist = [];
let mailStatus = null;
let dataStatus = null;

tabs.forEach((tab) => {
  tab.addEventListener('click', () => showStep(Number(tab.dataset.step || 0)));
});

document.querySelectorAll('[data-next]').forEach((button) => {
  button.addEventListener('click', () => showStep(Math.min(currentStep + 1, panels.length - 1)));
});

document.querySelectorAll('[data-prev]').forEach((button) => {
  button.addEventListener('click', () => showStep(Math.max(currentStep - 1, 0)));
});

saveDealerButton.addEventListener('click', saveDealer);
uploadButton.addEventListener('click', uploadCsv);
uploadInput.addEventListener('change', validateSelectedCsv);
refreshButton.addEventListener('click', refresh);
simulateTestRunButton.addEventListener('click', simulateTestRun);
connectImapButton.addEventListener('click', connectImap);
mailTabs.forEach((tab) => {
  tab.addEventListener('click', () => showMailTab(tab.dataset.mailTab));
});

boot();

async function boot() {
  try {
    initSampleCsvDownload();
    await refresh();
    fillDealerForm();
    showStep(0);
    setPageStatus('Bereit');
  } catch (error) {
    handleError(error);
  }
}

async function refresh() {
  setPageStatus('Status wird geladen...');
  const [onboarding, mail, data] = await Promise.all([
    request('/api/onboarding'),
    request('/api/mail/status'),
    request('/api/data-status')
  ]);
  tenant = onboarding.tenant;
  checklist = onboarding.checklist || [];
  mailStatus = mail;
  dataStatus = data;
  renderStatus();
  setPageStatus('Status aktuell');
}

function fillDealerForm() {
  if (!tenant) return;
  dealerForm.elements.name.value = tenant.name || '';
  dealerForm.elements.locationName.value = tenant.onboarding?.locationName || '';
  dealerForm.elements.contactName.value = tenant.onboarding?.contactName || '';
  dealerForm.elements.contactEmail.value = tenant.onboarding?.contactEmail || '';
  dealerForm.elements.contactPhone.value = tenant.onboarding?.contactPhone || '';
}

async function saveDealer() {
  if (!dealerForm.reportValidity()) return;
  setPageStatus('Händlerdaten werden gespeichert...');
  const formData = new FormData(dealerForm);
  tenant = await request('/api/tenant', {
    method: 'POST',
    body: JSON.stringify({
      ...(tenant || {}),
      name: String(formData.get('name') || '').trim(),
      onboarding: {
        ...(tenant?.onboarding || {}),
        locationName: String(formData.get('locationName') || '').trim(),
        contactName: String(formData.get('contactName') || '').trim(),
        contactEmail: String(formData.get('contactEmail') || '').trim(),
        contactPhone: String(formData.get('contactPhone') || '').trim()
      }
    })
  });
  await refresh();
  showStep(1);
}

async function uploadCsv() {
  const file = uploadInput.files?.[0];
  if (!file) {
    uploadStatus.textContent = 'Bitte zuerst eine CSV auswählen.';
    return;
  }
  const csvText = await file.text();
  const validation = validateCsvText(csvText);
  renderCsvValidation(validation);
  if (!validation.ok) {
    uploadStatus.textContent = 'CSV wurde nicht hochgeladen. Bitte Fehler korrigieren.';
    return;
  }
  uploadStatus.textContent = 'CSV wird hochgeladen...';
  const headers = { 'Content-Type': file.type || 'text/csv' };
  let response = await fetch('/api/upload-csv', { method: 'POST', headers, body: csvText });
  if (response.status === 404) {
    response = await fetch('/api/upload/lager', { method: 'POST', headers, body: csvText });
  }
  if (response.status === 401) throw new Error('Nicht angemeldet. Bitte zuerst im Admin einloggen.');
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'CSV Upload fehlgeschlagen');
  }
  const articleCount = inventoryArticleCountFromPayload(payload);
  localStorage.setItem(inventoryCountStorageKey(), String(articleCount));
  uploadStatus.textContent = `✅ ${articleCount} Artikel im Lager`;
  await refresh();
  showStep(3);
}

async function simulateTestRun() {
  simulateTestRunButton.disabled = true;
  simulateTestRunButton.textContent = 'Draft wird erstellt...';
  setPageStatus('Test-Anfrage wird verarbeitet...');
  try {
    const inbound = await request('/api/inbound/email', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'onboarding_test',
        provider_message_id: `onboarding-test-${Date.now()}`,
        subject: 'Eduard Anfrage TEST',
        from_email: 'testkunde@example.com',
        received_at: new Date().toISOString(),
        raw_html: [
          '<table>',
          '<tr><td><strong>Vorname</strong></td><td>Max</td></tr>',
          '<tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>',
          '<tr><td><strong>E-mail-Adresse</strong></td><td>testkunde@example.com</td></tr>',
          '<tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>',
          '<tr><td>COC & Typisierung</td><td>&euro; 200,00</td></tr>',
          '</table>'
        ].join(''),
        raw_text: [
          'Vorname Max',
          'Nachname Mustermann',
          'E-mail-Adresse testkunde@example.com',
          'Hochlader 3318 3500kg EUR 3.000,00',
          'COC & Typisierung EUR 200,00'
        ].join('\n')
      })
    });
    if (inbound.offer_run_id) {
      await request(`/api/offer-runs/${encodeURIComponent(inbound.offer_run_id)}/process`, { method: 'POST' });
    }
    window.location.href = '/';
  } catch (error) {
    simulateTestRunButton.disabled = false;
    simulateTestRunButton.textContent = 'Ersten Draft simulieren →';
    handleError(error);
  }
}

async function connectImap() {
  if (!imapForm.reportValidity()) return;
  const tenantId = tenant?.id;
  if (!tenantId) {
    showImapResult('error', 'Händlerdaten zuerst speichern.');
    return;
  }

  const formData = new FormData(imapForm);
  const host = String(formData.get('host') || '').trim();
  const payload = {
    email: String(formData.get('email') || '').trim(),
    app_password: String(formData.get('app_password') || '').trim()
  };
  if (host) payload.host = host;
  connectImapButton.disabled = true;
  connectImapButton.textContent = 'Verbindung wird getestet...';
  hideImapResult();
  try {
    await request(`/api/tenant/${encodeURIComponent(tenantId)}/imap/connect`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showImapResult('ok', '✅ Verbunden! Eduard liest deine Mails alle 5 Minuten.\nDu kannst dieses Fenster jetzt schließen.');
    imapForm.reset();
    await refresh();
  } catch (error) {
    const hostMatch = String(error.message || '').match(/host=([^\s]+)/);
    const usedHost = hostMatch?.[1] || payload.host || 'dem IMAP-Server';
    showImapResult('error', `❌ Verbindung zu ${usedHost} fehlgeschlagen.

Häufige Ursachen:
• App-Passwort falsch kopiert → nochmal erstellen
• IMAP nicht aktiviert → outlook.live.com → Einstellungen → Mail → Weiterleitung und IMAP → IMAP einschalten
• Eigene Domain (z.B. @meinbetrieb.at) → IMAP-Host manuell eingeben ↓`);
  } finally {
    connectImapButton.disabled = false;
    connectImapButton.textContent = 'Verbindung testen';
  }
}

function showMailTab(name) {
  mailTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mailTab === name));
  mailPanels.forEach((panel) => {
    panel.hidden = panel.dataset.mailPanel !== name;
  });
}

function showImapResult(type, message) {
  imapResult.hidden = false;
  imapResult.className = `imap-result ${type}`;
  imapResult.textContent = message;
}

function hideImapResult() {
  imapResult.hidden = true;
  imapResult.textContent = '';
}

function initSampleCsvDownload() {
  sampleCsvDownload.href = '/api/sample-csv';
}

async function validateSelectedCsv() {
  const file = uploadInput.files?.[0];
  if (!file) {
    clearCsvValidation();
    uploadStatus.textContent = 'Keine Datei geladen.';
    return;
  }
  const validation = validateCsvText(await file.text());
  renderCsvValidation(validation);
  uploadStatus.textContent = validation.ok
    ? `CSV bereit. ${validation.rowCount} Datenzeilen erkannt.`
    : 'CSV enthält Fehler.';
}

function validateCsvText(csvText) {
  const rows = parseCsvRows(csvText || '');
  const headers = rows[0] || [];
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => String(cell || '').trim()));
  const mappedHeaders = Object.fromEntries(
    Object.entries(CSV_HEADER_ALIASES).map(([field, aliases]) => [field, findCsvHeader(headers, aliases)])
  );
  const errors = [];

  if (dataRows.length === 0) {
    errors.push('Die CSV enthält keine Datenzeilen.');
  }

  for (const field of CSV_REQUIRED_FIELDS) {
    if (!mappedHeaders[field]) {
      errors.push(`Pflichtspalte fehlt: ${CSV_HEADER_ALIASES[field].join(' oder ')}`);
    }
  }

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (mappedHeaders.sku && !csvCell(row, headers, mappedHeaders.sku)) {
      errors.push(`Zeile ${rowNumber}: Art.-Nr. fehlt.`);
    }
    if (mappedHeaders.name && !csvCell(row, headers, mappedHeaders.name)) {
      errors.push(`Zeile ${rowNumber}: Art.-Bez. fehlt.`);
    }
    if (mappedHeaders.stock && !isInteger(csvCell(row, headers, mappedHeaders.stock))) {
      errors.push(`Zeile ${rowNumber}: Lagermenge ist keine gültige Zahl.`);
    }
    if (mappedHeaders.stockValue && !isPositiveEuroNumber(csvCell(row, headers, mappedHeaders.stockValue))) {
      errors.push(`Zeile ${rowNumber}: Lagerwert/Preis ist leer oder ungültig.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    rowCount: dataRows.length
  };
}

function renderCsvValidation(validation) {
  if (validation.ok) {
    clearCsvValidation();
    return;
  }
  csvErrors.hidden = false;
  csvErrors.innerHTML = `<strong>CSV kann noch nicht hochgeladen werden:</strong><ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>`;
}

function clearCsvValidation() {
  csvErrors.hidden = true;
  csvErrors.innerHTML = '';
}

function parseCsvRows(csvText) {
  const delimiter = detectDelimiter(csvText);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some((value) => value)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value)) rows.push(row);
  return rows;
}

function detectDelimiter(csvText) {
  const firstLine = String(csvText || '').split(/\r?\n/, 1)[0] || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ';' : ',';
}

function findCsvHeader(headers, aliases) {
  const normalizedHeaders = headers.map((header) => ({ header, key: normalizeCsvHeader(header) }));
  for (const alias of aliases) {
    const wanted = normalizeCsvHeader(alias);
    const exact = normalizedHeaders.find((entry) => entry.key === wanted);
    if (exact) return exact.header;
  }
  return '';
}

function normalizeCsvHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function csvCell(row, headers, header) {
  const index = headers.indexOf(header);
  return index >= 0 ? String(row[index] || '').trim() : '';
}

function isInteger(value) {
  return /^-?\d+(\.0+|,0+)?$/.test(String(value || '').trim());
}

function isPositiveEuroNumber(value) {
  const normalized = String(value || '').trim().replace(/\./g, '').replace(',', '.');
  return Number.parseFloat(normalized) > 0;
}

function mailConnectionDetail() {
  if (mailStatus?.gmail?.connected) {
    return `✅ Gmail verbunden: ${mailStatus.gmail.email || 'verbunden'}`;
  }
  if (mailStatus?.outlook?.connected) {
    return `✅ Outlook verbunden: ${mailStatus.outlook.email || 'verbunden'}`;
  }
  return 'Noch nicht verbunden';
}

function inventoryArticleCountFromPayload(payload = {}) {
  return Number(payload.validation?.stats?.rows || payload.validation?.stats?.rowCount || payload.validation?.rowCount || 0);
}

function inventoryCountStorageKey() {
  return `eduard:onboarding:${tenant?.id || 'default'}:inventory-count`;
}

function inventoryStatusText() {
  const count = Number(localStorage.getItem(inventoryCountStorageKey()) || 0);
  return count > 0 ? `✅ ${count} Artikel im Lager` : 'Lager-CSV vorhanden';
}

function updateUploadStatus(csvLoaded) {
  if (!csvLoaded || uploadInput.files?.length) return;
  uploadStatus.textContent = inventoryStatusText();
}

function renderStatus() {
  const gmailConnected = Boolean(mailStatus?.gmail?.connected || mailStatus?.outlook?.connected);
  const csvLoaded = Boolean(dataStatus?.lagerCsvExists);
  const dealerReady = Boolean(tenant?.name);
  const mailDetail = mailConnectionDetail();
  updateUploadStatus(csvLoaded);
  const checks = [
    { label: 'Händlerdaten', done: dealerReady, detail: tenant?.name || 'Noch nicht gespeichert' },
    { label: 'Gmail OAuth', done: gmailConnected, detail: gmailConnected ? mailDetail : 'Noch nicht verbunden' },
    { label: 'CSV Upload', done: csvLoaded, detail: csvLoaded ? inventoryStatusText() : 'Noch keine CSV geladen' }
  ];

  for (const [index, tab] of tabs.entries()) {
    tab.classList.toggle('active', index === currentStep);
    tab.classList.toggle('done', index === 0 ? dealerReady : index === 1 ? gmailConnected : index === 2 ? csvLoaded : checks.every((check) => check.done));
  }

  mailChecks.innerHTML = [
    checkRow('Google OAuth', gmailConnected, gmailConnected ? mailDetail : 'Noch offen'),
    checkRow('Nächster Schritt', true, 'Nach der Verbindung zurück zu /onboarding')
  ].join('');
  finalChecks.innerHTML = [
    ...checks.map((check) => checkRow(check.label, check.done, check.detail)),
    ...checklist.map((item) => checkRow(item.label, item.done, item.detail))
  ].join('');
}

function showStep(index) {
  currentStep = index;
  panels.forEach((panel, panelIndex) => {
    panel.hidden = panelIndex !== index;
  });
  renderStatus();
}

function checkRow(label, done, detail) {
  return `<div class="check-row">
    <div><strong>${escapeHtml(label)}</strong><br><span>${escapeHtml(detail || '')}</span></div>
    <span class="status-pill ${done ? 'done' : 'open'}">${done ? 'Erledigt' : 'Offen'}</span>
  </div>`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await readResponse(response);
  if (response.status === 401) throw new Error('Nicht angemeldet. Bitte zuerst im Admin einloggen.');
  if (!response.ok) throw new Error(payload.message || payload.error || 'Anfrage fehlgeschlagen');
  return payload;
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function setPageStatus(message) {
  pageStatus.textContent = message;
}

function handleError(error) {
  setPageStatus(error.message);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
