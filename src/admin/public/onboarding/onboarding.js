const panels = [...document.querySelectorAll('[data-panel]')];
const tabs = [...document.querySelectorAll('[data-step]')];
const dealerForm = document.querySelector('#dealer-form');
const saveDealerButton = document.querySelector('#save-dealer');
const uploadButton = document.querySelector('#upload-csv');
const uploadInput = document.querySelector('#csv-file');
const uploadStatus = document.querySelector('#upload-status');
const pageStatus = document.querySelector('#onboarding-status');
const mailChecks = document.querySelector('#mail-checks');
const finalChecks = document.querySelector('#final-checks');
const refreshButton = document.querySelector('#refresh-status');

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
refreshButton.addEventListener('click', refresh);

boot();

async function boot() {
  try {
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
  uploadStatus.textContent = 'CSV wird hochgeladen...';
  const body = await file.arrayBuffer();
  const headers = { 'Content-Type': file.type || 'text/csv' };
  let response = await fetch('/api/upload-csv', { method: 'POST', headers, body });
  if (response.status === 404) {
    response = await fetch('/api/upload/lager', { method: 'POST', headers, body });
  }
  if (response.status === 401) throw new Error('Nicht angemeldet. Bitte zuerst im Admin einloggen.');
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'CSV Upload fehlgeschlagen');
  }
  uploadStatus.textContent = `CSV gespeichert. ${payload.validation?.stats?.rowCount || 0} Zeilen geprüft.`;
  await refresh();
  showStep(3);
}

function renderStatus() {
  const gmailConnected = Boolean(mailStatus?.gmail?.connected || mailStatus?.outlook?.connected);
  const csvLoaded = Boolean(dataStatus?.lagerCsvExists);
  const dealerReady = Boolean(tenant?.name);
  const checks = [
    { label: 'Händlerdaten', done: dealerReady, detail: tenant?.name || 'Noch nicht gespeichert' },
    { label: 'Gmail OAuth', done: gmailConnected, detail: gmailConnected ? 'Mailzugriff verbunden' : 'Noch nicht verbunden' },
    { label: 'CSV Upload', done: csvLoaded, detail: csvLoaded ? 'Lager-CSV vorhanden' : 'Noch keine CSV geladen' }
  ];

  for (const [index, tab] of tabs.entries()) {
    tab.classList.toggle('active', index === currentStep);
    tab.classList.toggle('done', index === 0 ? dealerReady : index === 1 ? gmailConnected : index === 2 ? csvLoaded : checks.every((check) => check.done));
  }

  mailChecks.innerHTML = [
    checkRow('Google OAuth', gmailConnected, gmailConnected ? 'Verbunden' : 'Noch offen'),
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
