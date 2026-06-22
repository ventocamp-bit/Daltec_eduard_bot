import { buildEditedDraftHtml } from './draft-review.js';

const form = document.querySelector('#settings-form');
const appView = document.querySelector('#app-view');
const loginView = document.querySelector('#login-view');
const loginForm = document.querySelector('#login-form');
const loginEmail = document.querySelector('#login-email');
const loginPassword = document.querySelector('#login-password');
const loginError = document.querySelector('#login-error');
const dataStatusEl = document.querySelector('#data-status');
const previewFrame = document.querySelector('#preview-frame');
const offerListEl = document.querySelector('#offer-list');
const offerCountEl = document.querySelector('#offer-count');
const runListEl = document.querySelector('#run-list');
const runCountEl = document.querySelector('#run-count');
const inventoryImportListEl = document.querySelector('#inventory-import-list');
const inventoryImportCountEl = document.querySelector('#inventory-import-count');
const runDetailEl = document.querySelector('#run-detail');
const runDetailBodyEl = document.querySelector('#run-detail-body');
const runDetailCloseEl = document.querySelector('#run-detail-close');
const setupReadyEl = document.querySelector('#setup-ready');
const setupChecksEl = document.querySelector('#setup-checks');
const setupNextEl = document.querySelector('#setup-next');
const monitoringStateEl = document.querySelector('#monitoring-state');
const monitoringGridEl = document.querySelector('#monitoring-grid');
const monitoringAlertsEl = document.querySelector('#monitoring-alerts');
const saasStateEl = document.querySelector('#saas-state');
const saasGridEl = document.querySelector('#saas-grid');
const saasBlockersEl = document.querySelector('#saas-blockers');
const reviewStateEl = document.querySelector('#review-state');
const reviewListEl = document.querySelector('#review-list');
const sendReviewDigestButton = document.querySelector('#send-review-digest');
const overviewOperationEl = document.querySelector('#overview-operation');
const overviewOperationDetailEl = document.querySelector('#overview-operation-detail');
const overviewProofEl = document.querySelector('#overview-proof');
const overviewProofDetailEl = document.querySelector('#overview-proof-detail');
const overviewFeedbackEl = document.querySelector('#overview-feedback');
const overviewFeedbackDetailEl = document.querySelector('#overview-feedback-detail');
const gmailQueryEl = document.querySelector('#gmail-query');
const copyQueryButton = document.querySelector('#copy-query');
const mailStatusEl = document.querySelector('#mail-status');
const gmailConnectEl = document.querySelector('#gmail-connect');
const outlookConnectEl = document.querySelector('#outlook-connect');
const localLoginEl = document.querySelector('#local-login');
const productGroupsEl = document.querySelector('#product-groups');
const addProductGroupButton = document.querySelector('#add-product-group');
const priceRulesEl = document.querySelector('#price-rules');
const addPriceRuleButton = document.querySelector('#add-price-rule');
const navButtons = Array.from(document.querySelectorAll('[data-panel-target]'));
const panelViews = Array.from(document.querySelectorAll('.panel-view'));
const contentShell = document.querySelector('.content-shell');
let currentSettings = {};

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#logout').addEventListener('click', logout);
document.querySelector('#lager-upload').addEventListener('change', () => uploadCsv('lager', '#lager-upload'));
copyQueryButton.addEventListener('click', copyGmailQuery);
gmailConnectEl.addEventListener('click', preventDisabledLink);
outlookConnectEl.addEventListener('click', preventDisabledLink);
addProductGroupButton.addEventListener('click', addProductGroup);
addPriceRuleButton.addEventListener('click', addPriceRule);
runListEl.addEventListener('click', openRunFromList);
monitoringAlertsEl.addEventListener('click', openRunFromList);
saasBlockersEl.addEventListener('click', openRunFromList);
reviewListEl.addEventListener('click', handleReviewQueueClick);
sendReviewDigestButton.addEventListener('click', sendReviewDigest);
runDetailCloseEl.addEventListener('click', () => {
  runDetailEl.hidden = true;
});
productGroupsEl.addEventListener('input', handleProductGroupsChange);
productGroupsEl.addEventListener('change', handleProductGroupsChange);
productGroupsEl.addEventListener('click', removeProductGroup);
priceRulesEl.addEventListener('input', () => schedulePreview());
priceRulesEl.addEventListener('change', () => schedulePreview());
priceRulesEl.addEventListener('click', removePriceRule);
loginForm.addEventListener('submit', login);
form.addEventListener('input', () => schedulePreview());
form.addEventListener('change', () => schedulePreview());
navButtons.forEach((button) => button.addEventListener('click', () => activatePanel(button.dataset.panelTarget)));

boot();

function activatePanel(panelId) {
  panelViews.forEach((panel) => {
    panel.classList.toggle('active', panel.id === panelId);
  });
  contentShell.classList.toggle('diagnostics-active', panelId === 'diagnostics-panel');
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.panelTarget === panelId);
  });
}

async function boot() {
  hideLocalLoginInProduction();
  hideLegacyCategoryDiscountInputs();
  try {
    await request('/api/auth/me');
    showApp();
    await load();
  } catch {
    showLogin();
  }
}

function hideLegacyCategoryDiscountInputs() {
  form.querySelectorAll('[name^="pricing.categoryDiscounts."]').forEach((input) => {
    const label = input.closest('label');
    if (label) label.hidden = true;
  });
}

function hideLocalLoginInProduction() {
  if (localLoginEl && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    localLoginEl.hidden = true;
  }
}

async function login(event) {
  event.preventDefault();
  await doLogin(loginEmail.value || 'admin@daltec.local', loginPassword.value || 'admin');
}

async function doLogin(email, password) {
  loginError.textContent = '';
  try {
    await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password
      })
    });
    loginPassword.value = '';
    showApp();
    await load();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

async function logout() {
  await request('/api/auth/logout', { method: 'POST' }).catch(() => null);
  showLogin();
}

function showApp() {
  appView.hidden = false;
  loginView.hidden = true;
}

function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
}

async function load() {
  setStatus('Lade Einstellungen...');
  const settings = await request('/api/settings');
  currentSettings = structuredClone(settings);
  fillForm(settings);
  await refreshSetupStatus();
  await refreshMonitoring();
  await refreshSaasReadiness();
  await refreshReviewQueue();
  await refreshMailStatus();
  await refreshDataStatus();
  await refreshInventoryImports();
  await refreshOffers();
  await refreshRuns();
  await preview();
  setStatus('Bereit');
}

async function save() {
  setStatus('Speichere...');
  const saved = await request('/api/settings', {
    method: 'POST',
    body: JSON.stringify(readForm())
  });
  currentSettings = structuredClone(saved);
  fillForm(saved);
  setStatus('Gespeichert');
  await preview();
}

async function preview() {
  setStatus('Erzeuge Vorschau...');
  const result = await request('/api/preview', {
    method: 'POST',
    body: JSON.stringify({ settings: readForm() })
  });
  previewFrame.srcdoc = result.html_angebot;
  setStatus('Vorschau aktuell');
}

function fillForm(settings, prefix = '') {
  if (!prefix && settings.pricing?.offerFactor != null) {
    settings = structuredClone(settings);
    settings.pricing.discountPercent = Math.round((1 - Number(settings.pricing.offerFactor)) * 100);
    settings.pricing.vatPercent = Math.round(Number(settings.pricing.vatRate ?? 0.2) * 100);
    renderProductGroups(settings.pricing);
    renderPriceRules(settings.pricing.rules || []);
  }
  for (const [key, value] of Object.entries(settings)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      fillForm(value, name);
      continue;
    }
    const input = form.elements[name];
    if (input && input.type === 'checkbox') input.checked = value === true;
    else if (input && isPlaceholderInput(input)) {
      input.placeholder = value;
      input.value = '';
    }
    else if (input) input.value = value;
  }
}

function readForm() {
  const settings = structuredClone(currentSettings || {});
  for (const input of form.elements) {
    if (!input.name) continue;
    if (isPlaceholderInput(input) && input.value.trim() === '') continue;
    setNested(settings, input.name, typedValue(input));
  }
  if (settings.pricing?.discountPercent != null) {
    settings.pricing.offerFactor = 1 - Number(settings.pricing.discountPercent) / 100;
    delete settings.pricing.discountPercent;
  }
  if (settings.pricing?.vatPercent != null) {
    settings.pricing.vatRate = Number(settings.pricing.vatPercent) / 100;
    delete settings.pricing.vatPercent;
  }
  settings.pricing ||= {};
  const productGroups = readProductGroups();
  settings.pricing.productGroups = productGroups;
  settings.pricing.categoryDiscounts = Object.fromEntries(
    productGroups.map((group) => [group.id, group.discountPercent])
  );
  settings.pricing.rules = readPriceRules();
  settings.mail ||= {};
  delete settings.mail.cc;
  delete settings.mail.internalSubject;
  return settings;
}

function renderProductGroups(pricing = {}) {
  const groups = normalizeProductGroups(pricing);
  productGroupsEl.innerHTML = `
    <div class="rule-row product-group-row rule-row-head">
      <span>Name</span>
      <span>Rabatt %</span>
      <span></span>
    </div>
    ${groups.map((group) => productGroupRow(group)).join('')}
  `;
}

function normalizeProductGroups(pricing = {}) {
  const configured = Array.isArray(pricing.productGroups) ? pricing.productGroups : [];
  const discounts = pricing.categoryDiscounts || {};
  const byId = new Map();
  for (const group of configured) {
    if (!group?.id) continue;
    byId.set(group.id, {
      ...group,
      label: group.label || group.id,
      match: group.match || group.label || group.id,
      discountPercent: Number(discounts[group.id] ?? group.discountPercent ?? 0),
      enabled: group.enabled !== false
    });
  }
  for (const [id, percent] of Object.entries(discounts)) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: defaultGroupLabel(id),
        match: defaultGroupMatch(id),
        discountPercent: Number(percent || 0),
        enabled: true
      });
    }
  }
  if (byId.size === 0) {
    byId.set('anhaenger', { id: 'anhaenger', label: 'Anhänger', match: 'anhaenger,anhänger,hochlader,kipper,autotransporter,flatbed', discountPercent: 13, enabled: true });
    byId.set('ersatzteile', { id: 'ersatzteile', label: 'Ersatzteile', match: 'ersatzteil,ersatzteile,spare part,spare parts', discountPercent: 13, enabled: true });
    byId.set('zubehoer', { id: 'zubehoer', label: 'Zubehör', match: 'zubehoer,zubehör,plane,spriegel,coc,typisierung,service,netzhaken,auffahrrampe,rampe,rampen,stossdaempfer,stoßdämpfer,shock absorbers,stuetzfuesse,stützfüße,supports,aufsatzbordwaende,aufsatzbordwände,bodenunterstuetzung,h-gestelle,led,beleuchtung,lighting,aspoeck,aspöck', discountPercent: 13, enabled: true });
  }
  return Array.from(byId.values());
}

function productGroupRow(group = {}) {
  return `
    <div class="rule-row product-group-row" data-product-group-row>
      <input data-group-field="label" type="text" value="${escapeHtml(group.label || '')}" placeholder="z.B. Ersatzteile">
      <input data-group-field="id" type="hidden" value="${escapeHtml(group.id || '')}">
      <input data-group-field="match" type="hidden" value="${escapeHtml(group.match || '')}">
      <input data-group-field="discountPercent" type="number" min="0" max="100" step="1" value="${Number(group.discountPercent ?? 0)}">
      <button type="button" class="icon-button" data-remove-product-group title="Gruppe entfernen">x</button>
    </div>
  `;
}

function readProductGroups() {
  return Array.from(productGroupsEl.querySelectorAll('[data-product-group-row]'))
    .map((row) => {
      const label = row.querySelector('[data-group-field="label"]').value.trim();
      const id = slugifyGroupId(row.querySelector('[data-group-field="id"]').value || label);
      return {
        id,
        label: label || id,
        match: row.querySelector('[data-group-field="match"]').value.trim() || label || id,
        discountPercent: Number(row.querySelector('[data-group-field="discountPercent"]').value || 0),
        enabled: true
      };
    })
    .filter((group) => group.id);
}

function defaultGroupLabel(id) {
  return { anhaenger: 'Anhänger', ersatzteile: 'Ersatzteile', zubehoer: 'Zubehör' }[id] || id;
}

function defaultGroupMatch(id) {
  return {
    anhaenger: 'anhaenger,anhänger,hochlader,kipper,autotransporter,flatbed',
    ersatzteile: 'ersatzteil,ersatzteile,spare part,spare parts',
    zubehoer: 'zubehoer,zubehör,plane,spriegel,coc,typisierung,service,netzhaken,auffahrrampe,rampe,rampen,stossdaempfer,stoßdämpfer,shock absorbers,stuetzfuesse,stützfüße,supports,aufsatzbordwaende,aufsatzbordwände,bodenunterstuetzung,h-gestelle,led,beleuchtung,lighting,aspoeck,aspöck'
  }[id] || id;
}

function slugifyGroupId(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function handleProductGroupsChange() {
  renderPriceRules(readPriceRules());
  schedulePreview();
}

function addProductGroup() {
  const rows = readProductGroups();
  rows.push({ id: 'neue_gruppe', label: 'Neue Gruppe', match: '', discountPercent: 13, enabled: true });
  renderProductGroups({
    productGroups: rows,
    categoryDiscounts: Object.fromEntries(rows.map((group) => [group.id, group.discountPercent]))
  });
  renderPriceRules(readPriceRules());
  schedulePreview();
}

function removeProductGroup(event) {
  if (!event.target.matches('[data-remove-product-group]')) return;
  event.target.closest('[data-product-group-row]').remove();
  renderPriceRules(readPriceRules());
  schedulePreview();
}

function renderPriceRules(rules = []) {
  const safeRules = Array.isArray(rules) ? rules : [];
  priceRulesEl.innerHTML = `
    <div class="rule-row price-rule-row rule-row-head">
      <span>Sorte / Produkt</span>
      <span>Kategorie</span>
      <span>%</span>
      <span></span>
    </div>
    ${safeRules.map((rule) => priceRuleRow(rule)).join('')}
  `;
}

function priceRuleRow(rule = {}) {
  const category = rule.category || 'alle';
  const source = rule.source || 'uvp_discount';
  const groups = readProductGroups().filter((group) => !['anhaenger', 'zubehoer'].includes(group.id));
  const matchOptions = ['', 'Hochlader', 'Rückwärtskipper', 'Dreiseitenkipper', 'Autotransporter', 'Plane', 'Aufsatzbordwand', 'Laubgitter'];
  const selectedMatch = rule.match || '';
  return `
    <div class="rule-row price-rule-row" data-rule-row>
      <select data-rule-field="match">
        ${matchOptions.map((value) => option(value, value || 'Alle', selectedMatch)).join('')}
        ${selectedMatch && !matchOptions.includes(selectedMatch) ? option(selectedMatch, selectedMatch, selectedMatch) : ''}
      </select>
      <select data-rule-field="category">
        ${option('alle', 'Alle', category)}
        ${groups.map((group) => option(group.id, group.label || group.id, category)).join('')}
        ${option('anhaenger', 'Anhänger', category)}
        ${option('zubehoer', 'Zubehör', category)}
      </select>
      <input data-rule-field="source" type="hidden" value="${escapeHtml(source || 'uvp_discount')}">
      <input data-rule-field="percent" type="number" min="0" max="300" step="1" value="${Number(rule.percent ?? 0)}">
      <button type="button" class="icon-button" data-remove-rule title="Regel entfernen">×</button>
    </div>
  `;
}

function option(value, label, selected) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

function readPriceRules() {
  return Array.from(priceRulesEl.querySelectorAll('[data-rule-row]'))
    .map((row) => ({
      match: row.querySelector('[data-rule-field="match"]').value.trim(),
      category: row.querySelector('[data-rule-field="category"]').value,
      source: row.querySelector('[data-rule-field="source"]').value,
      percent: Number(row.querySelector('[data-rule-field="percent"]').value || 0),
      enabled: true
    }))
    .filter((rule) => rule.percent > 0 || rule.match);
}

function addPriceRule() {
  const rows = readPriceRules();
  rows.push({ match: '', category: 'alle', source: 'uvp_discount', percent: 13, enabled: true });
  renderPriceRules(rows);
  schedulePreview();
}

function removePriceRule(event) {
  if (!event.target.matches('[data-remove-rule]')) return;
  event.target.closest('[data-rule-row]').remove();
  schedulePreview();
}

function typedValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') return Number(input.value);
  return input.value;
}

function isPlaceholderInput(input) {
  return input.type === 'text' || input.type === 'email';
}

async function uploadCsv(kind, selector) {
  const input = document.querySelector(selector);
  const file = input.files[0];
  if (!file) return;
  setStatus(`Lade ${kind} CSV hoch...`);
  const response = await fetch(`/api/upload/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'text/csv' },
    body: file
  });
  input.value = '';
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = result.validation?.errors?.map((error) => error.message).slice(0, 5) || [result.message || result.error || 'CSV Upload fehlgeschlagen'];
    dataStatusEl.textContent = messages.join(' | ');
    setStatus('CSV abgelehnt');
    return;
  }
  const warningText = result.validation?.warnings?.length
    ? ` | Hinweise: ${result.validation.warnings.map((warning) => warning.message).slice(0, 3).join(' | ')}`
    : '';
  dataStatusEl.textContent = `CSV gespeichert: ${result.validation?.stats?.rows || 0} Zeilen${warningText}`;
  await load();
}

async function refreshSetupStatus() {
  const setup = await request('/api/setup-status');
  setupReadyEl.textContent = setup.ready ? 'Bereit für Polling' : 'Setup offen';
  setupReadyEl.className = setup.ready ? 'ready' : 'open';
  gmailQueryEl.value = setup.forwarding.query;
  setupNextEl.textContent = setup.ready
    ? `Start: ${setup.nextCommands.join(' oder ')}`
    : setup.forwarding.action;
  setupChecksEl.innerHTML = setup.checks.map((check) => `
    <div class="setup-check ${check.done ? 'done' : 'open'}">
      <i></i>
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <small>${escapeHtml(check.detail)}</small>
      </div>
    </div>
  `).join('');
}

async function refreshMonitoring() {
  const snapshot = await request('/api/monitoring');
  const metrics = snapshot.metrics;
  monitoringStateEl.textContent = snapshot.alerts.length ? `${snapshot.alerts.length} Warnung(en)` : 'OK';
  monitoringStateEl.className = snapshot.alerts.some((alert) => alert.level === 'error') ? 'open' : 'ready';
  overviewOperationEl.textContent = snapshot.alerts.some((alert) => alert.level === 'error') ? 'Achtung' : 'Läuft';
  overviewOperationEl.className = snapshot.alerts.some((alert) => alert.level === 'error') ? 'open' : 'ready';
  overviewOperationDetailEl.textContent = `Mail ${metrics.mailConnected ? 'verbunden' : 'offen'} · CSV ${metrics.inventory.stale ? 'alt' : 'frisch'} · ${metrics.processedCount} verarbeitet`;
  monitoringGridEl.innerHTML = [
    monitorMetric('Runs 24h', metrics.runCount),
    monitorMetric('Ausgeschlossen', metrics.excludedRunCount),
    monitorMetric('Verarbeitet', metrics.processedCount),
    monitorMetric('Owner-Mail', metrics.sentToOwnerCount),
    monitorMetric('Needs Review', `${metrics.needsReviewCount} (${Math.round(metrics.needsReviewRate * 100)}%)`),
    monitorMetric('Failed', `${metrics.failedCount} (${Math.round(metrics.failedRate * 100)}%)`),
    monitorMetric('Duplikate', metrics.duplicateCount),
    monitorMetric('Verdacht doppelt', metrics.suspectedDuplicateRunCount || 0),
    monitorMetric('Feedback', metrics.ownerFeedbackCount),
    monitorMetric('Safe Draft Rate', metrics.safeDraftAcceptanceRate == null ? '-' : `${Math.round(metrics.safeDraftAcceptanceRate * 100)}%`),
    monitorMetric('CSV Positionen', `${metrics.inventory.itemCount}/${metrics.inventory.minItemCount}`),
    monitorMetric('CSV Alter', metrics.inventory.ageHours == null ? '-' : `${metrics.inventory.ageHours}h`)
  ].join('');
  monitoringAlertsEl.innerHTML = snapshot.alerts.length
    ? [
        ...snapshot.alerts.map((alert) => `<div class="monitor-alert ${escapeHtml(alert.level)}">${escapeHtml(alert.message)}</div>`),
        duplicateGroupsHtml(metrics.suspectedDuplicateGroups || [])
      ].join('')
    : '<div class="monitor-alert ok">Keine aktiven Alerts.</div>';
}

function monitorMetric(label, value) {
  return `<div class="monitor-metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

async function refreshSaasReadiness() {
  const snapshot = await request('/api/saas-readiness');
  saasStateEl.textContent = snapshot.sellableSaas
    ? 'Sellable'
    : snapshot.daltecDailyUseCandidate ? 'DALTEC Proof' : 'Blockiert';
  saasStateEl.className = snapshot.sellableSaas ? 'ready' : 'open';
  overviewProofEl.textContent = `${snapshot.metrics.processedRuns}/${snapshot.metrics.proofTargetRuns}`;
  overviewProofEl.className = snapshot.sellableSaas ? 'ready' : 'open';
  overviewProofDetailEl.textContent = snapshot.blockers?.length
    ? `${snapshot.blockers.length} Blocker: ${(snapshot.blockers || []).map((item) => item.code).slice(0, 2).join(', ')}`
    : 'Proof-Kriterien erfüllt.';
  saasGridEl.innerHTML = [
    monitorMetric('Status', snapshot.status),
    monitorMetric('Storage', snapshot.storageMode),
    monitorMetric('Proof Runs', `${snapshot.metrics.processedRuns}/${snapshot.metrics.proofTargetRuns}`),
    monitorMetric('Doppelt-Verdacht', snapshot.metrics.suspectedDuplicateRunCount || 0),
    monitorMetric('Feedback', `${snapshot.metrics.ownerFeedbackCount}/${snapshot.metrics.ownerFeedbackTarget}`),
    monitorMetric('Safe Draft', snapshot.metrics.safeDraftAcceptanceRate == null ? '-' : `${Math.round(snapshot.metrics.safeDraftAcceptanceRate * 100)}%`),
    monitorMetric('Backup', snapshot.runtime?.backup?.latestAgeHours == null ? 'fehlt' : `${snapshot.runtime.backup.latestAgeHours}h alt`)
  ].join('');
  const issues = [...(snapshot.blockers || []), ...(snapshot.warnings || [])];
  saasBlockersEl.innerHTML = issues.length
    ? [
        ...issues.map((issue) => `<div class="monitor-alert ${issue.severity === 'p0' ? 'error' : 'warning'}">${escapeHtml(issue.message)}</div>`),
        duplicateGroupsHtml(snapshot.metrics.recent?.suspectedDuplicateGroups || [])
      ].join('')
    : '<div class="monitor-alert ok">Keine SaaS-Blocker aktiv.</div>';
}

function duplicateGroupsHtml(groups = []) {
  if (!groups.length) return '';
  return `
    <div class="duplicate-groups">
      ${groups.map((group) => `
        <article class="duplicate-group">
          <div>
            <strong>${escapeHtml(group.customerEmail || 'Unbekannter Kunde')}</strong>
            <small>${escapeHtml(group.extraRuns || 0)} extra Run(s) | ${formatMoney(group.totalGross)}</small>
          </div>
          <div class="button-row compact-buttons">
            ${(group.runIds || []).map((runId, index) => `
              <button type="button" class="secondary" data-run-id="${escapeHtml(runId)}">Run ${index + 1}</button>
            `).join('')}
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

async function refreshReviewQueue() {
  const queue = await request('/api/review-queue');
  reviewStateEl.textContent = `${queue.openCount} offen | ${queue.feedbackCount}/${queue.targetFeedbackCount} Feedbacks`;
  reviewStateEl.className = queue.openCount ? 'open' : 'ready';
  overviewFeedbackEl.textContent = `${queue.feedbackCount}/${queue.targetFeedbackCount}`;
  overviewFeedbackEl.className = queue.feedbackCount >= queue.targetFeedbackCount ? 'ready' : 'open';
  overviewFeedbackDetailEl.textContent = queue.openCount
    ? `${queue.openCount} offene Bewertungen.`
    : 'Keine offenen Bewertungen.';
  reviewListEl.innerHTML = queue.items.length
    ? queue.items.slice(0, 6).map(reviewQueueItemHtml).join('')
    : '<div class="monitor-alert ok">Keine offenen Drafts ohne Feedback.</div>';
}

function reviewQueueItemHtml(item) {
  const warningText = item.warnings?.length ? item.warnings.join(', ') : 'keine Warnungen';
  return `
    <article class="review-item ${item.errorCode ? 'needs-review' : ''}">
      <button type="button" class="review-main" data-run-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.customerName || item.customerEmail || 'Unbekannter Kunde')}</strong>
        <small>${escapeHtml(item.errorMessage || item.match?.matched || item.subject || item.id)}</small>
        <span>${escapeHtml(item.status)} | ${formatMoney(item.totalGross)} | ${escapeHtml(item.match?.confidence || '-')}</span>
      </button>
      <div class="review-meta">
        <small>${escapeHtml(warningText)}</small>
        <div class="button-row compact-buttons">
          <button type="button" data-quick-feedback="sendable" data-run-id="${escapeHtml(item.id)}">Sendbar</button>
          <button type="button" class="secondary" data-quick-feedback="minor_correction" data-run-id="${escapeHtml(item.id)}">Korrektur</button>
          <button type="button" class="danger" data-quick-feedback="wrong" data-run-id="${escapeHtml(item.id)}">Falsch</button>
        </div>
      </div>
    </article>
  `;
}

async function handleReviewQueueClick(event) {
  const feedbackButton = event.target.closest('[data-quick-feedback]');
  if (feedbackButton) {
    await submitOwnerFeedback(feedbackButton.dataset.runId, feedbackButton.dataset.quickFeedback, { renderDetail: false });
    return;
  }
  const openButton = event.target.closest('[data-run-id]');
  if (openButton) await renderRunDetail(openButton.dataset.runId);
}

async function sendReviewDigest() {
  sendReviewDigestButton.disabled = true;
  setStatus('Sende Review Digest...');
  try {
    const result = await request('/api/review-queue/digest', {
      method: 'POST',
      body: JSON.stringify({ limit: 20 })
    });
    setStatus(result.delivered ? `Review Digest gesendet: ${result.count}` : `Review Digest nicht gesendet: ${result.reason || result.count}`);
  } finally {
    sendReviewDigestButton.disabled = false;
  }
}

async function refreshMailStatus() {
  const status = await request('/api/mail/status');
  const gmailText = status.gmail.connected
    ? `Gmail verbunden${status.gmail.email ? `: ${status.gmail.email}` : ''}`
    : status.gmail.configured ? 'Gmail bereit zum Verbinden' : 'Gmail OAuth App fehlt';
  const outlookText = status.outlook.connected
    ? `Outlook verbunden${status.outlook.email ? `: ${status.outlook.email}` : ''}`
    : status.outlook.configured ? 'Outlook bereit zum Verbinden' : 'Outlook OAuth App fehlt';
  mailStatusEl.textContent = `${gmailText} | ${outlookText}`;
  gmailConnectEl.textContent = status.gmail.connected ? 'Gmail neu verbinden' : 'Gmail verbinden';
  outlookConnectEl.textContent = status.outlook.connected ? 'Outlook neu verbinden' : 'Outlook verbinden';
  setConnectLinkState(gmailConnectEl, status.gmail.configured);
  setConnectLinkState(outlookConnectEl, status.outlook.configured);
}

function setConnectLinkState(link, enabled) {
  link.classList.toggle('disabled-link', !enabled);
  link.setAttribute('aria-disabled', String(!enabled));
  link.tabIndex = enabled ? 0 : -1;
}

function preventDisabledLink(event) {
  if (event.currentTarget.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
  }
}

async function copyGmailQuery() {
  await navigator.clipboard.writeText(gmailQueryEl.value);
  copyQueryButton.textContent = 'Kopiert';
  setTimeout(() => {
    copyQueryButton.textContent = 'Regel kopieren';
  }, 1200);
}

async function refreshOffers() {
  const offers = await request('/api/offers');
  offerCountEl.textContent = String(offers.length);
  offerListEl.innerHTML = offers.length
    ? offers.slice(0, 5).map((offer) => `
      <div class="offer-item">
        <div class="offer-main">
          <strong>${escapeHtml([offer.customer.firstName, offer.customer.lastName].filter(Boolean).join(' ') || offer.customer.email || 'Kunde')}</strong>
          <small>${escapeHtml(offer.source.subject || offer.offer.subject || 'Eduard Angebot')}</small>
        </div>
        <span class="offer-total">${formatMoney(offer.offer.totalGross)}</span>
      </div>
    `).join('')
    : '<div class="status">Noch keine gespeicherten Angebote</div>';
}

async function refreshRuns() {
  const runs = await request('/api/runs');
  runCountEl.textContent = String(runs.length);
  runListEl.innerHTML = runs.length
    ? runs.slice(0, 8).map((run) => `
      <button type="button" class="offer-item run-item" data-run-id="${escapeHtml(run.id)}">
        <div class="offer-main">
          <strong>${escapeHtml(run.summary?.customerName || run.summary?.customerEmail || run.inbound_message_id || 'Run')}</strong>
          <small>${escapeHtml(run.error_message || run.summary?.topInventoryName || run.id)}</small>
        </div>
        <span class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      </button>
    `).join('')
    : '<div class="status">Noch keine Verarbeitungen</div>';
}

async function openRunFromList(event) {
  const button = event.target.closest('[data-run-id]');
  if (!button) return;
  await renderRunDetail(button.dataset.runId);
}

async function renderRunDetail(runId) {
  setStatus('Lade Draft Review...');
  const run = await request(`/api/offer-runs/${encodeURIComponent(runId)}`);
  runDetailBodyEl.innerHTML = runDetailHtml(run);
  runDetailEl.hidden = false;
  runDetailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const form = runDetailBodyEl.querySelector('[data-draft-review-form]');
  form?.addEventListener('submit', (event) => sendEditedDraft(event, run.id));
  runDetailBodyEl.querySelector('[data-reject-draft]')?.addEventListener('click', () => rejectDraft(run.id));
  setStatus('Draft Review geladen');
}

function runDetailHtml(run) {
  const draft = draftReviewState(run);
  return `
    <form class="draft-review" data-draft-review-form>
      <div class="draft-review-head">
        <div>
          <p class="eyebrow">Draft Review</p>
          <h2>${escapeHtml(draft.customerName || 'Kundenangebot')}</h2>
        </div>
        <span class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      </div>

      <div class="inline two">
        <label>An <input data-draft-field="to" type="email" value="${escapeHtml(draft.to)}" required></label>
        <label>Betreff <input data-draft-field="subject" type="text" value="${escapeHtml(draft.subject)}" required></label>
      </div>

      <section class="draft-section">
        <strong>Anrede & Intro</strong>
        <textarea data-draft-field="intro" rows="5">${escapeHtml(draft.intro)}</textarea>
      </section>

      <section class="draft-section">
        <strong>Preistabelle</strong>
        <div class="editable-price-table" data-draft-table>
          <div class="editable-price-row editable-price-header">
            <span>Produkt</span><span>UVP</span><span>Rabatt</span><span>Angebot</span>
          </div>
          ${draft.rows.map((row) => draftPriceRowHtml(row)).join('')}
        </div>
      </section>

      <section class="draft-section">
        <strong>Hinweise</strong>
        <textarea data-draft-field="notes" rows="4">${escapeHtml(draft.notes)}</textarea>
      </section>

      <section class="draft-section">
        <strong>Signatur</strong>
        <textarea data-draft-field="signature" rows="5">${escapeHtml(draft.signature)}</textarea>
      </section>

      <div class="draft-message" data-draft-message hidden></div>
      <div class="draft-actions">
        <button type="button" class="danger" data-reject-draft>✗ Ablehnen</button>
        <button type="submit" data-send-draft>✓ Mail senden</button>
      </div>
    </form>
  `;
}

function draftPriceRowHtml(row) {
  return `
    <div class="editable-price-row ${escapeHtml(row.type || '')}" data-price-row data-row-type="${escapeHtml(row.type || '')}">
      <input data-price-field="product" type="text" value="${escapeHtml(row.product)}">
      <input data-price-field="uvp" type="text" value="${escapeHtml(row.uvp)}">
      <input data-price-field="discount" type="text" value="${escapeHtml(row.discount)}">
      <input data-price-field="offer" type="text" value="${escapeHtml(row.offer)}">
    </div>
  `;
}

function draftReviewState(run) {
  const customer = run.customer_json || {};
  const pricing = run.pricing_json || {};
  const customerName = run.summary?.customerName || [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const to = run.draft?.customer_email || run.summary?.customerEmail || customer.email || '';
  const subject = run.draft?.subject || run.draft_subject || `Ihr Eduard Angebot${customerName ? ` - ${customerName}` : ''}`;
  const paragraphs = draftParagraphs(run.draft?.html_body || run.draft_html || '');
  return {
    customerName,
    to,
    subject,
    intro: paragraphs[0] || defaultIntro(customerName),
    rows: draftRows(run),
    notes: run.error_message || '',
    signature: paragraphs.at(-1) || defaultSignature(run.config_snapshot?.settings || {})
  };
}

function draftParagraphs(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('p'))
    .map((node) => node.textContent.trim())
    .filter(Boolean);
}

function defaultIntro(customerName) {
  return customerName
    ? `Sehr geehrte/r ${customerName},\n\nvielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen folgendes Fahrzeug an.`
    : 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen folgendes Fahrzeug an.';
}

function defaultSignature(settings = {}) {
  const signature = settings.signature || {};
  return [
    signature.greeting || 'Beste Grüße',
    signature.name || '',
    signature.company || '',
    signature.phone || '',
    signature.email || ''
  ].filter(Boolean).join('\n');
}

function draftRows(run) {
  const pricing = run.pricing_json || {};
  const items = Array.isArray(run.line_items_json) ? run.line_items_json : [];
  const rows = items.map((item) => ({
    product: item.produkt_name_original || item.name || item.produkt || 'Produkt',
    uvp: formatMoney(item.preis_mail_brutto_num || item.price || 0),
    discount: '',
    offer: formatMoney(item.preis_mail_brutto_num || item.price || 0),
    type: ''
  }));
  rows.push(
    { product: 'Gesamt netto', uvp: formatMoney(pricing.gesamt_uvp_netto || pricing.totalUvpNet || 0), discount: formatMoney(pricing.gesamt_rabatt_netto || 0), offer: formatMoney(pricing.gesamt_angebot_netto || 0), type: 'total' },
    { product: '20% MwSt', uvp: '', discount: '', offer: formatMoney(pricing.mwst_betrag || pricing.vat_amount || 0), type: 'total' },
    { product: 'Gesamt brutto', uvp: formatMoney(pricing.gesamt_uvp_brutto || pricing.uvpGross || 0), discount: formatMoney(pricing.gesamt_rabatt_brutto || 0), offer: formatMoney(pricing.gesamt_angebot_brutto || run.summary?.totalGross || 0), type: 'gross' }
  );
  return rows;
}

async function sendEditedDraft(event, runId) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[data-send-draft]');
  const message = form.querySelector('[data-draft-message]');
  button.disabled = true;
  button.textContent = 'Sendet...';
  message.hidden = true;
  try {
    const payload = buildEditedDraftPayload(form);
    const result = await request(`/api/offer-runs/${encodeURIComponent(runId)}/send-to-customer`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    form.querySelectorAll('input, textarea, button').forEach((element) => {
      element.disabled = true;
    });
    message.hidden = false;
    message.className = 'draft-message ok';
    message.textContent = `Mail gesendet: ${new Date(result.sent_at).toLocaleString('de-AT')}`;
    await refreshRuns();
    await refreshReviewQueue();
    await refreshMonitoring();
    await refreshSaasReadiness();
  } catch (error) {
    button.disabled = false;
    button.textContent = '✓ Mail senden';
    message.hidden = false;
    message.className = 'draft-message error';
    message.textContent = error.message;
  }
}

async function rejectDraft(runId) {
  await submitOwnerFeedback(runId, 'rejected', { renderDetail: false });
  runDetailEl.hidden = true;
}

function buildEditedDraftPayload(form) {
  const to = form.querySelector('[data-draft-field="to"]').value.trim();
  const subject = form.querySelector('[data-draft-field="subject"]').value.trim();
  const html = buildEditedDraftHtml({
    intro: form.querySelector('[data-draft-field="intro"]').value,
    rows: Array.from(form.querySelectorAll('[data-price-row]')).map((row) => ({
      type: row.dataset.rowType || '',
      product: row.querySelector('[data-price-field="product"]').value,
      uvp: row.querySelector('[data-price-field="uvp"]').value,
      discount: row.querySelector('[data-price-field="discount"]').value,
      offer: row.querySelector('[data-price-field="offer"]').value
    })),
    notes: form.querySelector('[data-draft-field="notes"]').value,
    signature: form.querySelector('[data-draft-field="signature"]').value
  });
  return { to, subject, html };
}

function debugMetric(label, value) {
  return `<div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function debugBlock(title, value) {
  return `
    <section class="debug-block">
      <strong>${escapeHtml(title)}</strong>
      <pre>${escapeHtml(JSON.stringify(value ?? null, null, 2))}</pre>
    </section>
  `;
}

function feedbackLabel(rating) {
  return {
    sendable: 'Sendbar',
    minor_correction: 'Kleine Korrektur nötig',
    wrong: 'Falsch',
    rejected: 'Abgelehnt'
  }[rating] || rating || '-';
}

async function submitOwnerFeedback(runId, rating, options = {}) {
  const notes = runDetailBodyEl.querySelector('[data-feedback-notes]')?.value || '';
  await request(`/api/offer-runs/${encodeURIComponent(runId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ rating, notes })
  });
  if (options.renderDetail !== false) await renderRunDetail(runId);
  await refreshRuns();
  await refreshReviewQueue();
  await refreshMonitoring();
  await refreshSaasReadiness();
}

async function refreshDataStatus() {
  const status = await request('/api/data-status');
  dataStatusEl.textContent = [
    `Lager-/Preisdaten: ${status.lagerCsvExists ? 'vorhanden' : 'nicht vorhanden'}`,
    status.usingLocalCsv ? 'bereit' : 'bitte CSV hochladen',
    status.latestInventoryImport ? `letzter Import: ${status.latestInventoryImport.status}` : 'kein Mail-Import'
  ].join(' | ');
}

async function refreshInventoryImports() {
  if (!inventoryImportListEl) return;
  const imports = await request('/api/inventory-imports');
  inventoryImportCountEl.textContent = String(imports.length);
  inventoryImportListEl.innerHTML = imports.length
    ? imports.slice(0, 8).map((item) => {
      const error = item.errors?.[0]?.message || '';
      const detail = [
        item.source?.filename || item.source?.subject || 'Lagerimport',
        `${item.rowCount || 0} Zeilen`,
        error
      ].filter(Boolean).join(' | ');
      return `
        <div class="offer-item">
          <div class="offer-main">
            <strong>${escapeHtml(item.status === 'success' ? 'Import OK' : 'Import Fehler')}</strong>
            <small>${escapeHtml(detail)}</small>
          </div>
          ${item.replyMailFailed ? '<span class="run-status failed_terminal">Antwortmail fehlgeschlagen</span>' : ''}
          <span class="run-status ${item.status === 'success' ? 'completed' : 'failed_terminal'}">${escapeHtml(item.status)}</span>
        </div>
      `;
    }).join('')
    : '<div class="status">Noch keine automatischen Lagerimporte</div>';
}

function setNested(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/me')) {
      showLogin();
    }
    throw new Error(data.error || response.statusText);
  }
  return data;
}

function setStatus(message) {
  document.title = message ? `Eduard Admin - ${message}` : 'Eduard Admin';
}

function formatMoney(value) {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let previewTimer;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    preview().catch((error) => setStatus(error.message));
  }, 180);
}
