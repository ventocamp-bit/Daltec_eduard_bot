const form = document.querySelector('#settings-form');
const appView = document.querySelector('#app-view');
const loginView = document.querySelector('#login-view');
const loginForm = document.querySelector('#login-form');
const loginEmail = document.querySelector('#login-email');
const loginPassword = document.querySelector('#login-password');
const loginError = document.querySelector('#login-error');
const dataStatusEl = document.querySelector('#data-status');
const previewFrame = document.querySelector('#preview-frame');
const previewStateLabel = document.querySelector('#preview-state-label');
const offerListEl = document.querySelector('#offer-list');
const offerCountEl = document.querySelector('#offer-count');
const runListEl = document.querySelector('#run-list');
const runCountEl = document.querySelector('#run-count');
const inboundStatusListEl = document.querySelector('#inbound-status-list');
const inboundStatusCountEl = document.querySelector('#inbound-status-count');
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
const historyStateEl = document.querySelector('#history-state');
const historyListEl = document.querySelector('#history-list');
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
const manualIngestButton = document.querySelector('#btn-manual-ingest');
const productGroupsEl = document.querySelector('#product-groups');
const addProductGroupButton = document.querySelector('#add-product-group');
const priceRulesEl = document.querySelector('#price-rules');
const addPriceRuleButton = document.querySelector('#add-price-rule');
const navButtons = Array.from(document.querySelectorAll('[data-panel-target]'));
const panelViews = Array.from(document.querySelectorAll('.panel-view'));
const contentShell = document.querySelector('.content-shell');
let currentSettings = {};
let activeDraftPreviewForm = null;
let editableOfferSaveTimer;
let editableOfferRenderTimer;
let editableOfferRenderSequence = 0;

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#logout').addEventListener('click', logout);
document.querySelector('#lager-upload').addEventListener('change', () => uploadCsv('lager', '#lager-upload'));
copyQueryButton.addEventListener('click', copyGmailQuery);
gmailConnectEl.addEventListener('click', preventDisabledLink);
outlookConnectEl.addEventListener('click', preventDisabledLink);
manualIngestButton.addEventListener('click', manualIngest);
addProductGroupButton.addEventListener('click', addProductGroup);
addPriceRuleButton.addEventListener('click', addPriceRule);
  runListEl.addEventListener('click', (e) => {
    handleRetryClick(e);
    openRunFromList(e);
  });
  inboundStatusListEl.addEventListener('click', (e) => {
    handleRetryClick(e);
    openRunFromList(e);
  });
monitoringAlertsEl.addEventListener('click', openRunFromList);
saasBlockersEl.addEventListener('click', openRunFromList);
reviewListEl.addEventListener('click', handleReviewQueueClick);
historyListEl.addEventListener('click', openHistoryRun);
sendReviewDigestButton.addEventListener('click', sendReviewDigest);
runDetailCloseEl.addEventListener('click', () => {
  runDetailEl.hidden = true;
  contentShell.classList.remove('review-detail-active');
  activeDraftPreviewForm = null;
  preview().catch((error) => setStatus(error.message));
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
  await refreshHistory();
  await refreshMailStatus();
  await refreshDataStatus();
  await refreshInventoryImports();
  await refreshInboundStatus();
  await refreshOffers();
  await refreshRuns();
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
  if (activeDraftPreviewForm) {
    syncDraftPreview(activeDraftPreviewForm);
    return;
  }
  setStatus('Erzeuge Vorschau...');
  const result = await request('/api/preview', {
    method: 'POST',
    body: JSON.stringify({ settings: readForm() })
  });
  previewFrame.srcdoc = result.html_angebot;
  previewStateLabel.textContent = 'Live';
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
  const warningText = reviewFlagText(item.warnings || [], item.errorCode);
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

async function refreshHistory() {
  const runs = await request('/api/offer-runs?status=sent_to_customer,rejected');
  historyStateEl.textContent = `${runs.length} Einträge`;
  historyListEl.innerHTML = runs.length
    ? `
      <div class="history-table">
        <div class="history-row history-head">
          <span>Datum</span><span>Kunde</span><span>Produkt</span><span>Preis</span><span>Status</span>
        </div>
        ${runs.map(historyRowHtml).join('')}
      </div>
    `
    : '<div class="monitor-alert ok">Noch keine gesendeten oder abgelehnten Angebote.</div>';
}

function historyRowHtml(run) {
  return `
    <button type="button" class="history-row" data-history-run-id="${escapeHtml(run.id)}">
      <span>${escapeHtml(formatDateTime(run.completed_at || run.updated_at || run.created_at))}</span>
      <span>${escapeHtml(run.summary?.customerName || run.summary?.customerEmail || run.customer_json?.email || 'Unbekannt')}</span>
      <span>${escapeHtml(historyProduct(run))}</span>
      <span>${escapeHtml(formatMoney(run.summary?.totalGross || run.pricing_json?.gesamt_angebot_brutto || 0))}</span>
      <span><span class="run-status ${escapeHtml(run.status)}">${escapeHtml(historyStatusLabel(run.status))}</span></span>
    </button>
  `;
}

function historyProduct(run) {
  const firstItem = Array.isArray(run.line_items_json) ? run.line_items_json[0] : null;
  return firstItem?.produkt_name_original || firstItem?.name || run.summary?.topInventoryName || run.match_json?.topInventoryName || '-';
}

async function openHistoryRun(event) {
  const button = event.target.closest('[data-history-run-id]');
  if (!button) return;
  await renderRunDetail(button.dataset.historyRunId, { readOnly: true });
}

async function handleReviewQueueClick(event) {
  const feedbackButton = event.target.closest('[data-quick-feedback]');
  if (feedbackButton) {
    await submitOwnerFeedback(feedbackButton.dataset.runId, feedbackButton.dataset.quickFeedback);
    return;
  }
  const openButton = event.target.closest('[data-run-id]');
  if (openButton) await renderRunDetail(openButton.dataset.runId);
}

async function handleRetryClick(event) {
  const retryBtn = event.target.closest('[data-retry-run]');
  if (!retryBtn) return;
  
  event.stopPropagation();
  retryBtn.disabled = true;
  const originalText = retryBtn.textContent;
  retryBtn.textContent = 'Sende...';
  
  try {
    const res = await request(`/api/offer-runs/${encodeURIComponent(retryBtn.dataset.retryRun)}/retry`, { method: 'POST' });
    retryBtn.textContent = 'Erfolg';
    retryBtn.classList.replace('secondary', 'success');
    setTimeout(() => {
      refreshRuns();
      refreshInboundStatus();
    }, 1500);
  } catch (err) {
    retryBtn.textContent = 'Fehler';
    retryBtn.classList.add('danger');
    setTimeout(() => {
      retryBtn.disabled = false;
      retryBtn.textContent = originalText;
      retryBtn.classList.remove('danger');
    }, 3000);
  }
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

async function manualIngest() {
  const rawText = window.prompt('Bitte den rohen Mail-Text oder die Anfrage hier hineinkopieren:');
  if (!rawText || !rawText.trim()) return;
  await request('/api/debug/manual-ingest', {
    method: 'POST',
    body: JSON.stringify({ rawText })
  });
  window.location.reload();
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
      <div class="offer-item run-item">
        <div class="offer-main" data-run-id="${escapeHtml(run.id)}" style="cursor:pointer;flex:1;">
          <strong>${escapeHtml(run.summary?.customerName || run.summary?.customerEmail || run.inbound_message_id || 'Run')}</strong>
          <small>${escapeHtml(run.error_message || run.summary?.topInventoryName || run.id)}</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
          ${run.status === 'needs_review' ? `<button type="button" class="secondary" data-retry-run="${escapeHtml(run.id)}" style="padding:4px 8px;font-size:12px;">Neu senden</button>` : ''}
        </div>
      </div>
    `).join('')
    : '<div class="status">Noch keine Verarbeitungen</div>';
}

async function refreshInboundStatus() {
  const snapshot = await request('/api/inbound-status?limit=25');
  inboundStatusCountEl.textContent = String(snapshot.items.length);
  inboundStatusListEl.innerHTML = snapshot.items.length
    ? snapshot.items.slice(0, 8).map(inboundStatusItemHtml).join('')
    : '<div class="status">Noch keine eingegangenen Mails</div>';
}

function inboundStatusItemHtml(item) {
  const lastEvent = item.lastEvent?.message || item.lastEvent?.event_type || '';
  const reason = item.error_message || lastEvent || item.subject || item.runId;
  const eventTrail = (item.events || [])
    .map((event) => event.event_type)
    .filter(Boolean)
    .join(' -> ');
  return `
    <button type="button" class="offer-item run-item inbound-status-item" data-run-id="${escapeHtml(item.runId)}">
      <div class="offer-main">
        <strong>${escapeHtml(item.subject || 'Eingang ohne Betreff')}</strong>
        <small>${escapeHtml([item.provider, item.from, formatDateTime(item.receivedAt)].filter(Boolean).join(' | '))}</small>
        <small>${escapeHtml(reason)}</small>
        ${eventTrail ? `<small>${escapeHtml(eventTrail)}</small>` : ''}
      </div>
      <span class="run-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
    </button>
  `;
}

async function openRunFromList(event) {
  const button = event.target.closest('[data-run-id]');
  if (!button) return;
  await renderRunDetail(button.dataset.runId);
}

async function renderRunDetail(runId, options = {}) {
  setStatus('Lade Draft Review...');
  const [run, reviewState] = await Promise.all([
    request(`/api/offer-runs/${encodeURIComponent(runId)}`),
    request(`/api/offer-runs/${encodeURIComponent(runId)}/review-state`)
  ]);
  runDetailBodyEl.innerHTML = runDetailHtml(run, { ...options, reviewState });
  runDetailEl.hidden = false;
  contentShell.classList.add('review-detail-active');
  runDetailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const form = runDetailBodyEl.querySelector('[data-draft-review-form]');
  if (form) {
    activeDraftPreviewForm = form;
    if (!options.readOnly) {
      form.addEventListener('submit', (event) => sendEditedDraft(event, run.id));
      form.addEventListener('input', (event) => handleDraftReviewInput(event, form));
      form.addEventListener('change', (event) => {
        recalculateDraftTotals(form);
        syncDraftPreview(form);
        saveEditableOfferState(run.id, form).catch((error) => handleDraftSaveError(form, error));
      });
      form.addEventListener('click', (event) => handleDraftTableClick(event, form));
    }
    recalculateDraftTotals(form);
    syncDraftPreview(form);
  }
  if (!options.readOnly) {
    runDetailBodyEl.querySelector('[data-reject-draft]')?.addEventListener('click', () => rejectDraft(run.id));
  }
  setStatus('Draft Review geladen');
}

function runDetailHtml(run, options = {}) {
  const draft = options.reviewState || draftReviewState(run);
  const readOnly = options.readOnly === true;
  const testMode = isOnboardingTestRun(run);
  const needsManualCorrection = run.summary?.needsManualCorrection === true;
  const disabled = readOnly ? ' disabled' : '';
  const sendDisabled = testMode || needsManualCorrection ? ' disabled' : '';
  return `
    <form class="draft-review" data-draft-review-form data-run-id="${escapeHtml(run.id)}" data-editable-offer-version="${Number(draft.version || run.summary?.editable_offer_version || 1)}" style="--offer-table-header-bg:${escapeHtml(draft.theme?.offerTableHeaderBg || '#F2B400')}">
      <div class="draft-review-head">
        <div>
          <p class="eyebrow">${readOnly ? 'Verlauf' : 'Draft Review'}</p>
          <h2>${escapeHtml(draft.customerName || 'Kundenangebot')}</h2>
        </div>
        <span class="run-status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      </div>

      ${reviewFlagsHtml(run)}
      ${testMode ? '<div class="review-flags">Test-Draft aus dem Onboarding - Senden ist deaktiviert.</div>' : ''}
      ${originalMailHtml(run)}

      ${customerEmailCopyBannerHtml(draft.to)}

      <div class="draft-ssot-note">
        <strong>Mail-Vorschau f&uuml;r H&auml;ndler anzeigen</strong>
        <span>Die Vorschau rechts wird aus genau denselben Feldern gebaut, die beim Senden verschickt werden.</span>
        <button type="button" class="secondary" data-show-mail-preview${readOnly ? ' hidden' : ''}>Vorschau aktualisieren</button>
      </div>

      <div class="inline two">
        <label>An <span class="field-badge editable">Dauerhaft anpassbar</span><input data-draft-field="to" type="email" value="${escapeHtml(draft.to)}" required${disabled}></label>
        <label>Betreff <span class="field-badge editable">Dauerhaft anpassbar</span><input data-draft-field="subject" type="text" value="${escapeHtml(draft.subject)}" required${disabled}></label>
      </div>

      ${catalogReadOnlySummaryHtml(draft.catalog)}

      <section class="draft-section">
        <strong>Anrede & Intro <span class="field-badge editable">Dauerhaft anpassbar</span></strong>
        <textarea data-draft-field="intro" rows="5"${disabled}>${escapeHtml(draft.intro)}</textarea>
      </section>

      <section class="draft-section">
        <strong>Preistabelle <span class="field-badge editable">Dauerhaft anpassbar</span></strong>
        <table class="editable-price-table" data-draft-table>
          <thead>
            <tr>
              <th>Position</th>
              <th>UVP Netto</th>
              <th>Rabatt</th>
              <th>Angebot Netto</th>
            </tr>
          </thead>
          <tbody>
          ${draft.rows.map((row) => draftPriceRowHtml(row, { readOnly })).join('')}
          </tbody>
        </table>
        <button type="button" class="secondary add-draft-row" data-add-draft-row${readOnly ? ' hidden' : ''}>+ Zeile hinzuf&uuml;gen</button>
      </section>
      ${inventoryAlternativeToggleHtml(draft, { readOnly })}
      <script type="application/json" data-draft-extra-tables>${jsonScriptContent(draft.baseExtraTables)}</script>

      <section class="draft-section">
        <strong>Hinweise (optional) <span class="field-badge editable">Dauerhaft anpassbar</span></strong>
        <textarea data-draft-field="notes" rows="4"${disabled}>${escapeHtml(draft.notes)}</textarea>
      </section>

      <section class="draft-section">
        <strong>Signatur <span class="field-badge editable">Dauerhaft anpassbar</span></strong>
        <textarea data-draft-field="signature" rows="5"${disabled}>${escapeHtml(draft.signature)}</textarea>
      </section>

      <div class="draft-message" data-draft-message hidden></div>
      <div class="draft-actions"${readOnly ? ' hidden' : ''}>
        <button type="button" class="danger" data-reject-draft>Ablehnen</button>
        <button type="submit" data-send-draft${sendDisabled}>${needsManualCorrection ? 'Korrektur nötig' : testMode ? 'Test-Draft' : 'Mail senden'}</button>
      </div>
    </form>
  `;
}

function isOnboardingTestRun(run) {
  return run?.inbound_message?.provider === 'onboarding_test';
}

function customerEmailCopyBannerHtml(email) {
  const value = String(email || '').trim();
  if (!value) return '';
  return `
    <button type="button" class="customer-email-copy" data-copy-customer-email data-email="${escapeHtml(value)}">
      <span class="customer-email-copy-value">&#128203; ${escapeHtml(value)}</span>
      <small data-copy-label>Klicken zum Kopieren</small>
    </button>
  `;
}

function draftPriceRowHtml(row, options = {}) {
  const calculated = ['total', 'vat', 'gross'].includes(row.type);
  const rowLocked = calculated || options.readOnly;
  const productReadonly = rowLocked ? ' readonly aria-readonly="true"' : '';
  const valueReadonly = rowLocked ? ' readonly aria-readonly="true"' : '';
  const deleteButton = !calculated && !options.readOnly
    ? '<button type="button" class="row-delete" data-delete-draft-row aria-label="Zeile löschen">×</button>'
    : '';
  return `
    <tr class="editable-price-row ${escapeHtml(row.type || 'item')}" data-price-row data-row-type="${escapeHtml(row.type || 'item')}"${calculated ? ' data-calculated-row' : ''}>
      <td><input data-price-field="product" type="text" value="${escapeHtml(row.product)}"${productReadonly}>${deleteButton}</td>
      <td><input data-price-field="uvpNet" type="text" inputmode="decimal" value="${escapeHtml(row.uvpNet || '')}"${valueReadonly}></td>
      <td><input data-price-field="discount" type="text" value="${escapeHtml(row.discount || '')}" readonly aria-readonly="true"></td>
      <td><input data-price-field="offerNet" type="text" inputmode="decimal" value="${escapeHtml(row.offerNet || '')}"${valueReadonly}></td>
    </tr>
  `;
}

function draftReviewState(run) {
  const customer = run.customer_json || {};
  const pricing = run.pricing_json || {};
  const saved = run.summary?.editable_offer || {};
  const customerName = run.summary?.customerName || [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const paragraphs = draftParagraphs(run.draft?.html_body || run.draft_html || '');
  const extraTables = draftExtraTables(run);
  const defaultRows = draftRows(run);
  const rows = Array.isArray(saved.rows) && saved.rows.length ? saved.rows : defaultRows;
  const inventoryAlternativeEnabled = saved.inventory_alternative?.enabled !== false;
  const inventoryReplacement = normalizeInventoryReplacement(saved.inventory_alternative?.replacement);
  const visibleExtraTables = inventoryReplacement.enabled ? replacementExtraTables(extraTables, inventoryReplacement) : extraTables;
  return {
    customerName,
    to: saved.to || run.draft?.customer_email || run.summary?.customerEmail || customer.email || '',
    subject: saved.subject || run.draft?.subject || run.draft_subject || `Ihr Eduard Angebot${customerName ? ` - ${customerName}` : ''}`,
    intro: saved.intro ?? (paragraphs[0] || defaultIntro(customerName)),
    rows,
    extraTables: visibleExtraTables,
    baseExtraTables: extraTables,
    inventoryReplacement,
    inventoryAlternativeAvailable: visibleExtraTables.length > 0,
    inventoryAlternativeEnabled,
    inventoryAlternativeName: extraTables[0]?.intro?.replace(/^Passendes Lagerfahrzeug:\s*/, '') || '',
    notes: saved.notes ?? draftNotesFromHtml(draftOriginalHtml(run)),
    signature: saved.signature ?? (paragraphs.at(-1) || defaultSignature(run.config_snapshot?.settings || {})),
    catalog: catalogReadOnlySummary(run),
    theme: reviewTheme(run.config_snapshot?.settings || {})
  };
}

function reviewTheme(settings = {}) {
  const candidate = settings.theme?.offerTableHeaderBg || '#F2B400';
  const color = /^#[0-9a-f]{6}$/i.test(String(candidate || '')) ? String(candidate) : '#F2B400';
  return {
    offerTableHeaderBg: color.toUpperCase()
  };
}

function catalogReadOnlySummary(run) {
  const pricing = run.pricing_json || {};
  const first = Array.isArray(pricing.positionen) ? pricing.positionen[0] : null;
  const match = run.match_json || {};
  return {
    product: first?.produkt_name || run.line_items_json?.[0]?.produkt_name_original || '',
    family: first?.product_family || '',
    sku: first?.produktcode || run.line_items_json?.[0]?.artikelnummer || '',
    inventory: match.top_lager_name || match.topInventoryName || ''
  };
}

function catalogReadOnlySummaryHtml(catalog = {}) {
  const items = [
    ['Haupt-Produkt', catalog.product],
    ['Produktfamilie', catalog.family],
    ['Artikelnummer', catalog.sku],
    ['Lager-Vorschlag', catalog.inventory]
  ].filter((item) => item[1]);
  if (!items.length) return '';
  return `
    <section class="draft-readonly-source" data-readonly-source="catalog">
      <strong>Grunddaten aus Product Catalog <span class="field-badge readonly">Nur lesend</span></strong>
      <dl>
        ${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
      </dl>
    </section>
  `;
}

function draftOriginalHtml(run) {
  return run.draft?.html_body || run.draft_html || '';
}

function originalMailHtml(run) {
  const body = originalMailBody(run);
  if (!body) return '';
  return `
    <details class="original-mail">
      <summary>Original-Kundenanfrage anzeigen</summary>
      <pre>${escapeHtml(body)}</pre>
    </details>
  `;
}

function originalMailBody(run) {
  const inbound = run.inbound_message || {};
  if (inbound.raw_text) return inbound.raw_text;
  if (inbound.raw_html) return htmlToPlainText(inbound.raw_html);
  if (run.raw_input?.text) return run.raw_input.text;
  if (run.raw_input?.html) return htmlToPlainText(run.raw_input.html);
  return '';
}

function htmlToPlainText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function reviewFlagsHtml(run) {
  const labels = [];
  if (run.summary?.needsManualCorrection === true) {
    labels.push('Manuelle Korrektur nötig');
  }
  const text = reviewFlagText(reviewFlagCodesFromRun(run), run.error_code);
  if (text && text !== 'keine Warnungen') labels.push(text);
  if (!labels.length) return '';
  return `<div class="review-flags${run.summary?.needsManualCorrection === true ? ' manual-correction' : ''}">${labels.map(escapeHtml).join(' | ')}</div>`;
}

function reviewFlagCodesFromRun(run) {
  return [
    ...(Array.isArray(run.match_json?.warnings) ? run.match_json.warnings : []),
    ...(Array.isArray(run.pricing_json?.warnings) ? run.pricing_json.warnings : [])
  ].map((warning) => warning.code || warning).filter(Boolean);
}

function reviewFlagText(codes = [], errorCode = '') {
  const labels = new Set([...(codes || []), errorCode].filter(Boolean).map(reviewFlagLabel));
  labels.delete('');
  return labels.size ? [...labels].join(' | ') : 'keine Warnungen';
}

function reviewFlagLabel(code) {
  return {
    sku_not_exact: '⚠️ Kein exakter Lager-Treffer – bitte prüfen',
    weight_mismatch: '⚠️ Gewicht weicht ab',
    low_confidence: '⚠️ Unsichere Erkennung – bitte Anfrage lesen',
    inventory_not_safe: '⛔ Lagerbestand zu niedrig',
    length_mismatch: '⚠️ Maße weichen ab',
    weak_inventory_match: '⚠️ Unsichere Erkennung – bitte Anfrage lesen',
    no_inventory_match: '⚠️ Kein exakter Lager-Treffer – bitte prüfen'
  }[code] || '⚠️ Bitte prüfen';
}

function draftParagraphs(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('p'))
    .map((node) => node.textContent.trim())
    .filter(Boolean);
}

function draftNotesFromHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.querySelectorAll('div'));
  const hintBlock = blocks.find((block) => {
    const style = block.getAttribute('style') || '';
    return /border\s*:\s*1px solid #ccc/i.test(style) || /background\s*:\s*#f9f9f9/i.test(style);
  });
  return hintBlock?.textContent.trim() || '';
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
  const positions = Array.isArray(pricing.positionen) ? pricing.positionen : [];
  const rows = positions.length
    ? positions.map((position) => {
      const uvpNet = Number(position.uvp_netto || 0);
      const offerNet = Number(position.angebot_netto || 0);
      return {
        product: position.produkt_name || 'Produkt',
        uvpNet: formatPriceInput(uvpNet),
        discount: formatPriceInput(uvpNet - offerNet),
        offerNet: formatPriceInput(offerNet),
        type: 'item'
      };
    })
    : items.map((item) => {
      const net = Number(item.preis_mail_brutto_num || item.price || 0) / 1.2;
      return {
        product: item.produkt_name_original || item.name || item.produkt || 'Produkt',
        uvpNet: formatPriceInput(net),
        discount: formatPriceInput(0),
        offerNet: formatPriceInput(net),
        type: 'item'
      };
    });
  rows.push(
    { product: 'Gesamt netto', uvpNet: formatPriceInput(0), discount: formatPriceInput(0), offerNet: formatPriceInput(0), type: 'total' },
    { product: '20% MwSt', uvpNet: formatPriceInput(0), discount: formatPriceInput(0), offerNet: formatPriceInput(0), type: 'vat' },
    { product: 'Gesamt Brutto (inkl. MwSt.)', uvpNet: formatPriceInput(0), discount: formatPriceInput(0), offerNet: formatPriceInput(0), type: 'gross' }
  );
  return rows;
}

function draftExtraTables(run) {
  const match = run.match_json || {};
  const lagerCalc = match.kalkulation_lager;
  const hasInventoryMatch = match.hat_match === true || match.hasInventoryMatch === true;
  if (!hasInventoryMatch || !lagerCalc) return [];
  const rows = draftRowsFromCalc(lagerCalc);
  if (!rows.length) return [];
  return [{
    title: 'SOFORT AB LAGER VERFÜGBAR',
    intro: `Passendes Lagerfahrzeug: ${match.top_lager_name || match.topInventoryName || run.summary?.topInventoryName || 'Lagerfahrzeug'}`,
    rows
  }];
}

function normalizeInventoryReplacement(input = {}) {
  return {
    enabled: input?.enabled === true,
    inventory_sku: String(input?.inventory_sku || '').trim(),
    inventory_name: String(input?.inventory_name || '').trim(),
    reason: String(input?.reason || '').trim()
  };
}

function replacementExtraTables(extraTables = [], replacement = {}) {
  if (!replacement.enabled || !extraTables.length) return extraTables;
  return extraTables.map((table, tableIndex) => {
    if (tableIndex !== 0) return table;
    const displayName = replacementDisplayName(replacement);
    return {
      ...table,
      intro: [
        `Passendes Lagerfahrzeug: ${displayName || 'Lagerfahrzeug'}`,
        replacement.reason ? `Grund: ${replacement.reason}` : ''
      ].filter(Boolean).join(' - '),
      replacement,
      rows: (table.rows || []).map((row, rowIndex) => (
        rowIndex === 0 && row.type === 'item'
          ? { ...row, product: displayName || row.product }
          : row
      ))
    };
  });
}

function replacementDisplayName(replacement = {}) {
  const name = replacement.inventory_name || '';
  const sku = replacement.inventory_sku || '';
  if (!name) return sku;
  if (!sku || name.includes(sku)) return name;
  return `${name} (Art.Nr: ${sku})`;
}

function inventoryAlternativeToggleHtml(draft, options = {}) {
  if (!draft.inventoryAlternativeAvailable) return '';
  const checked = draft.inventoryAlternativeEnabled ? ' checked' : '';
  const disabled = options.readOnly ? ' disabled' : '';
  const replacement = draft.inventoryReplacement || {};
  const replacementChecked = replacement.enabled ? ' checked' : '';
  return `
    <section class="draft-section inventory-alternative-control">
      <label class="draft-toggle">
        <input type="checkbox" data-inventory-alternative-toggle${checked}${disabled}>
        Lager-Alternative anzeigen
      </label>
      <div class="draft-readonly-source">
        <strong>Aktuelle vorgeschlagene Lager-Alternative <span class="field-badge readonly">Nur lesend</span></strong>
        <span>${escapeHtml(draft.inventoryAlternativeName || 'Lager-Alternative')}</span>
      </div>
      <div class="inventory-replacement">
        <strong>Alternative ersetzen <span class="field-badge editable">Dauerhaft anpassbar</span></strong>
        <label class="draft-toggle">
          <input type="checkbox" data-inventory-replacement-enabled${replacementChecked}${disabled}>
          Diese Alternative verwenden
        </label>
        <label>Artikelnummer (optional)
          <input data-inventory-replacement-field="inventory_sku" type="text" value="${escapeHtml(replacement.inventory_sku || '')}"${disabled}>
        </label>
        <label>Alternative Produktbezeichnung
          <input data-inventory-replacement-field="inventory_name" type="text" value="${escapeHtml(replacement.inventory_name || '')}"${disabled}>
        </label>
        <label>Warum ersetzt (optional)
          <textarea data-inventory-replacement-field="reason" rows="2"${disabled}>${escapeHtml(replacement.reason || '')}</textarea>
        </label>
      </div>
    </section>
  `;
}

function draftRowsFromCalc(calc = {}) {
  const positions = Array.isArray(calc.positionen) ? calc.positionen : [];
  const rows = positions.map((position) => {
    const uvpNet = Number(position.uvp_netto || 0);
    const offerNet = Number(position.angebot_netto || 0);
    return {
      product: position.produkt_name || 'Produkt',
      uvp: formatMoney(uvpNet),
      discount: formatMoney(uvpNet - offerNet),
      offer: formatMoney(offerNet),
      type: 'item'
    };
  });
  if (!rows.length) return [];
  const uvpNet = Number(calc.gesamt_uvp_netto || calc.gesamt_uvp_brutto / 1.2 || 0);
  const offerNet = Number(calc.gesamt_angebot_netto || calc.gesamt_angebot_brutto / 1.2 || 0);
  const discountNet = Number(calc.gesamt_rabatt_netto || calc.gesamt_rabatt_brutto / 1.2 || (uvpNet - offerNet));
  rows.push(
    { product: 'Gesamt netto', uvp: formatMoney(uvpNet), discount: formatMoney(discountNet), offer: formatMoney(offerNet), type: 'total' },
    { product: '20% MwSt', uvp: formatMoney(uvpNet * 0.2), discount: formatMoney(discountNet * 0.2), offer: formatMoney(offerNet * 0.2), type: 'vat' },
    { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: formatMoney(uvpNet * 1.2), discount: formatMoney(discountNet * 1.2), offer: formatMoney(offerNet * 1.2), type: 'gross' }
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
    await refreshHistory();
    await refreshMonitoring();
    await refreshSaasReadiness();
  } catch (error) {
    if (isConflictError(error)) {
      showDraftConflict(form);
      return;
    }
    button.disabled = false;
    button.textContent = 'Mail senden';
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
  recalculateDraftTotals(form);
  const editable_offer = editableOfferPayloadFromForm(form);
  return { to: editable_offer.to, subject: editable_offer.subject, editable_offer };
}

function syncDraftPreview(form) {
  clearTimeout(editableOfferRenderTimer);
  const renderSequence = ++editableOfferRenderSequence;
  previewStateLabel.textContent = 'Laedt';
  setStatus('Draft Vorschau wird gerendert...');
  editableOfferRenderTimer = setTimeout(() => {
    renderDraftPreview(form, renderSequence).catch((error) => {
      if (renderSequence !== editableOfferRenderSequence) return;
      showDraftError(form, error.message);
      setStatus('Draft Vorschau fehlgeschlagen');
    });
  }, 180);
}

async function renderDraftPreview(form, renderSequence) {
  const runId = form.dataset.runId;
  if (!runId) return;
  const result = await request(`/api/offer-runs/${encodeURIComponent(runId)}/render-editable-offer`, {
    method: 'POST',
    body: JSON.stringify({ editable_offer: editableOfferPayloadFromForm(form) })
  });
  if (renderSequence !== editableOfferRenderSequence) return;
  previewFrame.srcdoc = result.html;
  previewStateLabel.textContent = 'Draft';
  setStatus('Draft Vorschau aktuell');
}
function draftExtraTablesFromForm(form) {
  const toggle = form.querySelector('[data-inventory-alternative-toggle]');
  if (toggle && !toggle.checked) return [];
  const source = form.querySelector('[data-draft-extra-tables]')?.textContent || '[]';
  try {
    const tables = JSON.parse(source);
    if (!Array.isArray(tables)) return [];
    const replacement = replacementFromForm(form);
    return replacement.enabled && replacement.inventory_name ? replacementExtraTables(tables.slice(0, 1), replacement) : tables;
  } catch {
    return [];
  }
}

function jsonScriptContent(value) {
  return JSON.stringify(value || []).replace(/</g, '\\u003c');
}

function editableOfferPayloadFromForm(form) {
  const toggle = form.querySelector('[data-inventory-alternative-toggle]');
  const replacement = replacementFromForm(form);
  return {
    to: form.querySelector('[data-draft-field="to"]').value.trim(),
    subject: form.querySelector('[data-draft-field="subject"]').value.trim(),
    intro: form.querySelector('[data-draft-field="intro"]').value,
    rows: editableRowsFromForm(form),
    extra_tables: draftExtraTablesFromForm(form),
    notes: form.querySelector('[data-draft-field="notes"]').value,
    signature: form.querySelector('[data-draft-field="signature"]').value,
    inventory_alternative: {
      enabled: toggle ? toggle.checked : true,
      replacement
    }
  };
}

function replacementFromForm(form) {
  return normalizeInventoryReplacement({
    enabled: form.querySelector('[data-inventory-replacement-enabled]')?.checked === true,
    inventory_sku: form.querySelector('[data-inventory-replacement-field="inventory_sku"]')?.value.trim() || '',
    inventory_name: form.querySelector('[data-inventory-replacement-field="inventory_name"]')?.value.trim() || '',
    reason: form.querySelector('[data-inventory-replacement-field="reason"]')?.value.trim() || ''
  });
}

function editableRowsFromForm(form) {
  return Array.from(form.querySelectorAll('[data-price-row]')).map((row) => ({
    type: row.dataset.rowType || '',
    product: row.querySelector('[data-price-field="product"]').value,
    uvpNet: row.querySelector('[data-price-field="uvpNet"]').value,
    discount: row.querySelector('[data-price-field="discount"]').value,
    offerNet: row.querySelector('[data-price-field="offerNet"]').value
  }));
}

async function saveEditableOfferState(runId, form) {
  if (form.dataset.editableOfferSaving === 'true') {
    form.dataset.editableOfferPending = 'true';
    return null;
  }
  form.dataset.editableOfferSaving = 'true';
  let latestEditableOffer = null;
  try {
    do {
      form.dataset.editableOfferPending = 'false';
      const result = await request(`/api/offer-runs/${encodeURIComponent(runId)}/editable-offer`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(form.dataset.editableOfferVersion || 1),
          editable_offer: editableOfferPayloadFromForm(form)
        })
      });
      if (result.version) {
        form.dataset.editableOfferVersion = String(result.version);
      }
      latestEditableOffer = result.editable_offer;
    } while (form.dataset.editableOfferPending === 'true');
    return latestEditableOffer;
  } finally {
    form.dataset.editableOfferSaving = 'false';
  }
}

function showDraftError(form, message) {
  const element = form.querySelector('[data-draft-message]');
  if (!element) return;
  element.hidden = false;
  element.className = 'draft-message error';
  element.textContent = message;
}

function handleDraftSaveError(form, error) {
  if (isConflictError(error)) {
    showDraftConflict(form);
    return;
  }
  showDraftError(form, error.message);
}

function isConflictError(error) {
  return Number(error?.status) === 409;
}

function showDraftConflict(form) {
  if (!form) return;
  if (editableOfferSaveTimer) {
    clearTimeout(editableOfferSaveTimer);
    editableOfferSaveTimer = null;
  }
  form.dataset.editableOfferConflict = 'true';
  const message = form.querySelector('[data-draft-conflict-message]') || document.createElement('div');
  message.dataset.draftConflictMessage = 'true';
  message.hidden = false;
  message.className = 'draft-message error';
  message.innerHTML = `
    <strong>ACHTUNG: Dieses Angebot wurde zwischenzeitlich von einem anderen Verkäufer aktualisiert oder bereits versendet!</strong>
    <button type="button" data-reload-current-run>Aktuellen Serverstand laden</button>
  `;
  if (!message.parentElement) {
    form.insertBefore(message, form.firstElementChild);
  }
  form.querySelectorAll('input, textarea, select, button').forEach((element) => {
    if (!element.matches('[data-reload-current-run]')) element.disabled = true;
  });
  const reloadButton = message.querySelector('[data-reload-current-run]');
  reloadButton.disabled = false;
  reloadButton.addEventListener('click', () => window.location.reload(), { once: true });
}

function handleDraftTableClick(event, form) {
  const emailCopyButton = event.target.closest('[data-copy-customer-email]');
  if (emailCopyButton) {
    copyCustomerEmail(emailCopyButton);
    return;
  }

  const deleteButton = event.target.closest('[data-delete-draft-row]');
  if (deleteButton) {
    const row = deleteButton.closest('[data-price-row]');
    if (row && !row.hasAttribute('data-calculated-row')) {
      row.remove();
      recalculateDraftTotals(form);
      syncDraftPreview(form);
    }
    return;
  }

  if (event.target.closest('[data-add-draft-row]')) {
    addDraftItemRow(form);
    recalculateDraftTotals(form);
    syncDraftPreview(form);
  }

  if (event.target.closest('[data-show-mail-preview]')) {
    recalculateDraftTotals(form);
    syncDraftPreview(form);
    previewFrame.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function copyCustomerEmail(button) {
  const text = button.dataset.email || '';
  const label = button.querySelector('[data-copy-label]');
  try {
    await copyTextToClipboard(text);
    if (label) {
      label.textContent = '✅ Kopiert!';
      setTimeout(() => {
        label.textContent = 'Klicken zum Kopieren';
      }, 1500);
    }
  } catch (error) {
    if (label) label.textContent = 'Kopieren fehlgeschlagen';
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function addDraftItemRow(form) {
  const tbody = form.querySelector('[data-draft-table] tbody');
  const firstCalculatedRow = tbody.querySelector('[data-calculated-row]');
  const template = document.createElement('template');
  template.innerHTML = draftPriceRowHtml({
    product: '',
    uvpNet: formatPriceInput(0),
    discount: formatPriceInput(0),
    offerNet: formatPriceInput(0),
    type: 'item'
  }).trim();
  tbody.insertBefore(template.content.firstElementChild, firstCalculatedRow);
}

function handleDraftReviewInput(event, form) {
  const input = event.target.closest('[data-price-field]');
  if (input && input.dataset.priceField !== 'product') {
    sanitizeMoneyInput(input);
  }
  recalculateDraftTotals(form);
  syncDraftPreview(form);
  scheduleEditableOfferSave(form);
}

function scheduleEditableOfferSave(form) {
  clearTimeout(editableOfferSaveTimer);
  const runId = form.dataset.runId;
  if (!runId) return;
  editableOfferSaveTimer = setTimeout(() => {
    saveEditableOfferState(runId, form).catch((error) => handleDraftSaveError(form, error));
  }, 450);
}

function sanitizeMoneyInput(input) {
  input.value = input.value.replace(/[^\d,.]/g, '');
}

function recalculateDraftTotals(form) {
  const itemRows = Array.from(form.querySelectorAll('[data-price-row]'))
    .filter((row) => !row.hasAttribute('data-calculated-row'));
  const totals = itemRows.reduce((sum, row) => {
    const uvpNet = parseMoney(row.querySelector('[data-price-field="uvpNet"]')?.value) || 0;
    const offerNet = parseMoney(row.querySelector('[data-price-field="offerNet"]')?.value) || 0;
    const discount = uvpNet - offerNet;
    const discountInput = row.querySelector('[data-price-field="discount"]');
    if (discountInput) discountInput.value = formatPriceInput(discount);
    return {
      uvpNet: sum.uvpNet + uvpNet,
      discount: sum.discount + discount,
      offerNet: sum.offerNet + offerNet
    };
  }, { uvpNet: 0, discount: 0, offerNet: 0 });
  setDraftCalculatedRow(form, 'total', totals);
  setDraftCalculatedRow(form, 'vat', {
    uvpNet: totals.uvpNet * 0.2,
    discount: totals.discount * 0.2,
    offerNet: totals.offerNet * 0.2
  });
  setDraftCalculatedRow(form, 'gross', {
    uvpNet: totals.uvpNet * 1.2,
    discount: totals.discount * 1.2,
    offerNet: totals.offerNet * 1.2
  });
}

function setDraftCalculatedRow(form, rowType, values) {
  const row = form.querySelector(`[data-row-type="${rowType}"]`);
  if (!row) return;
  for (const [field, value] of Object.entries(values)) {
    const input = row.querySelector(`[data-price-field="${field}"]`);
    if (input) input.value = value === '' ? '' : formatPriceInput(value);
  }
}

function draftMailPriceValue(row, fieldBase) {
  const field = { uvp: 'uvpNet', discount: 'discount', offer: 'offerNet' }[fieldBase];
  const value = row.querySelector(`[data-price-field="${field}"]`)?.value || '';
  return formatMoney(parseMoney(value) || 0);
}

function parseMoney(value) {
  const normalized = String(value || '')
    .replace(/[^\d,.]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  return Number.parseFloat(normalized) || 0;
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
  await refreshHistory();
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
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setStatus(message) {
  document.title = message ? `Eduard Admin - ${message}` : 'Eduard Admin';
}

function formatMoney(value) {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

function formatPriceInput(value) {
  return new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('de-AT');
}

function historyStatusLabel(status) {
  return {
    sent_to_customer: 'Gesendet',
    rejected: 'Abgelehnt'
  }[status] || status || '-';
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
