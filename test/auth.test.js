import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test, { it } from 'node:test';
import { createPasswordHash, verifyPassword } from '../src/auth.js';
import { createAdminApp } from '../src/admin/server.js';
import { buildEditedDraftHtml } from '../src/admin/public/draft-review.js';
import {
  filterReplayDuplicateRuns,
  findReplayDuplicateIds,
  findSuspectedDuplicateGroups,
  getProofTargetRuns,
  isArchivedProofRun,
  tenantIdFromHost
} from '../src/admin/server.js';
import { createFeedbackToken } from '../src/feedback-token.js';
import { inspectRuntimeReadiness } from '../src/production-readiness.js';
import { checkEditableOfferConsistency } from '../src/core/editable-offer.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { processOfferRun, recordOwnerFeedback } from '../src/offer-run-service.js';
import { ingestInboundMessage, loadOfferRun, updateOfferRun } from '../src/storage.js';

test('password hashes verify only the original password', () => {
  const hash = createPasswordHash('secret-pass');
  assert.equal(verifyPassword('secret-pass', hash), true);
  assert.equal(verifyPassword('wrong-pass', hash), false);
});

test('production readiness blocks unsafe SaaS runtime defaults', () => {
  const blocked = inspectRuntimeReadiness({
    env: {
      NODE_ENV: 'production',
      APP_BASE_URL: 'http://localhost:3030',
      ADMIN_PASSWORD: 'admin',
      ADMIN_SESSION_SECRET: 'change-this-long-random-secret',
      EDUARD_INGEST_SECRET: 'dev-secret',
      POSTGRES_PASSWORD: 'eduard-postgres-local-change-me',
      GOOGLE_OAUTH_VERIFIED: 'false'
    },
    config: { app: { baseUrl: 'http://localhost:3030' } },
    settings: { mail: { deliveryMode: 'owner_review' } },
    mailStatus: { gmail: { connected: false }, outlook: { connected: false } },
    backup: { configured: false, latestAgeHours: null, maxAgeHours: 26 }
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.some((item) => item.code === 'postgres_enabled'), true);
  assert.equal(blocked.blockers.some((item) => item.code === 'backup_recent'), true);
  assert.equal(blocked.blockers.some((item) => item.code === 'oauth_verified_or_forwarding'), true);

  const ready = inspectRuntimeReadiness({
    env: {
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://angebote.daltec.at',
      DATABASE_URL: 'postgres://eduard:secret@example/eduard',
      ADMIN_PASSWORD_HASH: createPasswordHash('long-random-production-password'),
      ADMIN_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      EDUARD_INGEST_SECRET: 'abcdef0123456789abcdef0123456789',
      POSTGRES_PASSWORD: 'postgres-secret-0123456789abcdef',
      SAAS_MAIL_MODE: 'central_forwarding',
      GOOGLE_OAUTH_VERIFIED: 'false'
    },
    config: { app: { baseUrl: 'https://angebote.daltec.at' } },
    settings: { mail: { deliveryMode: 'owner_review' } },
    mailStatus: { gmail: { connected: true }, outlook: { connected: false } },
    backup: { configured: true, latestAgeHours: 1, maxAgeHours: 26 }
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.warnings.some((item) => item.code === 'central_forwarding_mode'), true);
});

test('monitoring detects suspected duplicate processed runs by customer and priced line items', () => {
  const baseRun = {
    customer_json: { email: 'HA1KA1H@aon.at' },
    summary: { totalGross: 3190 },
    line_items_json: [
      { produkt_name_original: '3518 -GD- Hochlader, Bordwände 30cm -2000kg- Lfh: 56cm -195/55R10', preis_mail_brutto_num: 3008.33 },
      { produkt_name_original: 'COC', preis_mail_brutto_num: 12.5 },
      { produkt_name_original: 'Typisierung', preis_mail_brutto_num: 33.33 }
    ]
  };

  const groups = findSuspectedDuplicateGroups([
    { ...baseRun, id: 'run-a', inbound_message: { provider_message_id: 'gmail-a', subject: 'Fw: Neuer Lead' } },
    { ...baseRun, id: 'run-b', inbound_message: { provider_message_id: 'gmail-b', subject: 'WG: Neuer Lead' } },
    {
      id: 'run-c',
      customer_json: { email: 'other@example.com' },
      line_items_json: [{ produkt_name_original: 'Hochlader anderer Kunde', preis_mail_brutto_num: 3008.33 }]
    }
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].customerEmail, 'ha1ka1h@aon.at');
  assert.equal(groups[0].extraRuns, 1);
  assert.deepEqual(groups[0].runIds, ['run-a', 'run-b']);
});

test('readiness ignores replay duplicates when a matching Gmail run exists', () => {
  const baseRun = {
    customer_json: { email: 'kunde@example.com' },
    summary: { totalGross: 3190 },
    status: 'sent_to_owner',
    line_items_json: [
      { produkt_name_original: 'Hochlader 3318 3500kg', preis_mail_brutto_num: 3190 }
    ]
  };
  const gmailRun = {
    ...baseRun,
    id: 'gmail-run',
    inbound_message: {
      provider: 'gmail',
      provider_message_id: 'gmail-message-1',
      subject: 'WG: Neuer Lead'
    }
  };
  const replayRun = {
    ...baseRun,
    id: 'replay-run',
    inbound_message: {
      provider: 'replay',
      provider_message_id: 'gmail-message-1',
      subject: 'WG: Neuer Lead'
    }
  };
  const replayRunWithDifferentMessageId = {
    ...baseRun,
    id: 'replay-run-different-message',
    inbound_message: {
      provider: 'replay',
      provider_message_id: 'gmail-message-2',
      subject: 'WG: Neuer Lead'
    }
  };

  const runs = [gmailRun, replayRun, replayRunWithDifferentMessageId];

  assert.deepEqual([...findReplayDuplicateIds(runs)], ['replay-run', 'replay-run-different-message']);
  assert.deepEqual(filterReplayDuplicateRuns(runs).map((run) => run.id), ['gmail-run']);
  assert.equal(findSuspectedDuplicateGroups(runs).length, 0);
});

test('readiness archives ignored proof runs', () => {
  assert.equal(isArchivedProofRun({ status: 'ignored' }), true);
  assert.equal(isArchivedProofRun({ status: 'completed' }), false);
  assert.equal(isArchivedProofRun({ status: 'sent_to_owner' }), false);
});

test('editable offer consistency check uses the same state for review preview and mail', () => {
  const run = {
    id: 'consistency-run',
    customer_json: { email: 'kunde@example.at', first_name: 'Thomas', last_name: 'Ofner' },
    summary: {
      customerName: 'Thomas Ofner',
      editable_offer: { inventory_alternative: { enabled: false } }
    },
    pricing_json: {
      positionen: [{ produkt_name: '3318-4-P3-2063 Hochlader', uvp_netto: 3000, angebot_netto: 2800 }],
      gesamt_uvp_netto: 3000,
      gesamt_angebot_netto: 2800
    },
    match_json: {
      hat_match: true,
      top_lager_name: 'Hochlader 330x180x30 2000kg H=63cm',
      kalkulation_lager: {
        positionen: [{ produkt_name: 'Hochlader 330x180x30 2000kg H=63cm (Art.Nr: 3318-4-P3-2063)', uvp_netto: 4200, angebot_netto: 3900 }],
        gesamt_uvp_netto: 4200,
        gesamt_angebot_netto: 3900
      }
    }
  };

  const hidden = checkEditableOfferConsistency(run);
  assert.equal(hidden.ok, true);
  assert.equal(hidden.editable_offer.inventory_alternative.enabled, false);
  assert.equal(hidden.review.tableCount, 1);
  assert.equal(hidden.preview.tableCount, 1);
  assert.equal(hidden.mail.tableCount, 1);
  assert.equal(hidden.preview.inventoryHeading, null);

  const shown = checkEditableOfferConsistency({
    ...run,
    summary: { ...run.summary, editable_offer: { inventory_alternative: { enabled: true } } }
  });
  assert.equal(shown.ok, true);
  assert.equal(shown.review.tableCount, 2);
  assert.equal(shown.preview.tableCount, 2);
  assert.equal(shown.mail.tableCount, 2);
  assert.equal(shown.preview.inventoryHeading, 'SOFORT AB LAGER VERFÜGBAR');

  const replaced = checkEditableOfferConsistency({
    ...run,
    summary: {
      ...run.summary,
      editable_offer: {
        inventory_alternative: {
          enabled: true,
          replacement: {
            enabled: true,
            inventory_sku: '4020-4-PO3-3063',
            inventory_name: 'Hochlader mit Rampen 406x200x30 3000kg H=63cm Rampen',
            reason: 'Bessere fachliche Alternative mit Rampen'
          }
        }
      }
    }
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.review.inventory_name, 'Hochlader mit Rampen 406x200x30 3000kg H=63cm Rampen');
  assert.equal(replaced.preview.inventory_name, 'Hochlader mit Rampen 406x200x30 3000kg H=63cm Rampen');
  assert.equal(replaced.mail.inventory_name, 'Hochlader mit Rampen 406x200x30 3000kg H=63cm Rampen');
  assert.equal(replaced.review.inventoryModel, 'Hochlader mit Rampen 406x200x30 3000kg H=63cm Rampen (Art.Nr: 4020-4-PO3-3063)');
  assert.equal(replaced.review.tableCount, 2);
  assert.equal(replaced.review.inventoryTableCount, 1);
  assert.equal(replaced.preview.inventoryTableCount, 1);
  assert.equal(replaced.mail.inventoryTableCount, 1);
  assert.equal(replaced.preview.originalInventoryStillVisible, false);
  assert.equal(replaced.mail.originalInventoryStillVisible, false);
});

test('readiness proof target can be configured by environment', () => {
  assert.equal(getProofTargetRuns({ PROOF_TARGET_RUNS: '62' }), 62);
  assert.equal(getProofTargetRuns({}), 100);
});

test('admin tenant is selected from host header', async () => {
  assert.equal(tenantIdFromHost('angebote.daltec.at'), 'daltec-local');
  assert.equal(tenantIdFromHost('angebote.haemmerle.at'), 'haemmerle-local');
  assert.equal(tenantIdFromHost('unknown.example.at'), 'daltec-local');
  assert.equal(tenantIdFromHost('kunden.example.at', { TENANT_HOST_MAP: 'kunden.example.at=kunden-local' }), 'kunden-local');

  const passwordHash = createPasswordHash('secret-pass');
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret: 'host-session-secret',
      cookieName: 'host_session',
      secureCookie: false
    },
    gmailProofAnalyzer: async (options) => {
      assert.equal(options.tenantId, 'haemmerle-local');
      return { messageCount: 0, messages: [], productsByCategory: {} };
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'angebote.haemmerle.at' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'angebote.haemmerle.at' }
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).tenantId, 'haemmerle-local');

    const proof = await fetch(`${baseUrl}/api/gmail/proof-analysis?limit=1`, {
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'angebote.haemmerle.at' }
    });
    assert.equal(proof.status, 200);
  } finally {
    server.close();
  }
});

test('manual correction feedback flags the run and blocks customer send', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'manual-correction-session-secret';
  const tenantId = `manual-correction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const host = 'manual-correction.example.at';
  const previousEnv = {
    TENANT_HOST_MAP: process.env.TENANT_HOST_MAP,
    DATABASE_URL: process.env.DATABASE_URL
  };
  process.env.TENANT_HOST_MAP = `${host}=${tenantId}`;
  delete process.env.DATABASE_URL;

  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'manual_correction_session',
      secureCookie: false
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const inbound = await ingestInboundMessage({
      provider: 'manual_test',
      provider_message_id: `manual-correction-${Date.now()}`,
      subject: 'Eduard Anfrage',
      from_email: 'kunde@example.at',
      raw_html: '<table><tr><td>Hochlader 3318</td><td>3000</td></tr></table>',
      raw_text: ''
    }, { tenantId });
    const runId = inbound.run.id;
    await updateOfferRun(runId, {
      status: 'completed',
      draft_subject: 'Angebot',
      draft_html: '<p>Angebot</p>',
      summary: { editable_offer_version: 1 }
    }, { tenantId });

    const flagged = await recordOwnerFeedback(runId, { rating: 'minor_correction', notes: 'Bitte korrigieren' }, { tenantId });
    assert.equal(flagged.owner_feedback.rating, 'minor_correction');
    assert.equal(flagged.summary.needsManualCorrection, true);
    const loadedFlagged = await loadOfferRun(runId, { tenantId });
    assert.equal(loadedFlagged.events.some((event) => event.event_type === 'owner_feedback_recorded'), true);

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': host },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const blockedSend = await fetch(`${baseUrl}/api/offer-runs/${runId}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-Host': host },
      body: JSON.stringify({})
    });
    assert.equal(blockedSend.status, 409);
    assert.deepEqual(await blockedSend.json(), { ok: false, error: 'manual_correction_required' });

    const cleared = await recordOwnerFeedback(runId, { rating: 'sendable' }, { tenantId });
    assert.equal(cleared.owner_feedback.rating, 'sendable');
    assert.equal(cleared.summary.needsManualCorrection, false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public manual correction feedback sends one internal notification', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'manual-correction-notify-secret';
  const tenantId = `manual-correction-notify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previousEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    DATABASE_URL: process.env.DATABASE_URL
  };
  process.env.APP_BASE_URL = 'https://angebote.daltec.at';
  delete process.env.DATABASE_URL;
  const sentMails = [];
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'manual_correction_notify_session',
      secureCookie: false
    },
    mailRuntimeFactory: async () => ({
      provider: 'test',
      client: null,
      sendHtmlMail: async (client, message) => sentMails.push(message)
    })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const inbound = await ingestInboundMessage({
      provider: 'manual_test',
      provider_message_id: `manual-correction-notify-${Date.now()}`,
      subject: 'Eduard Anfrage Notification Proof',
      from_email: 'kunde@example.at',
      raw_html: '<table><tr><td>Hochlader 3318</td><td>3000</td></tr></table>',
      raw_text: ''
    }, { tenantId });
    const runId = inbound.run.id;
    await updateOfferRun(runId, {
      status: 'completed',
      draft_subject: 'Angebot Notification Proof',
      draft_html: '<p>Angebot</p>',
      customer_json: { first_name: 'Michael', last_name: 'Proof', email: 'kunde@example.at' },
      line_items_json: [{ produkt_name_original: 'Cargo-Hochlader 311x160' }],
      summary: { customerName: 'Michael Proof', customerEmail: 'kunde@example.at', editable_offer_version: 1 }
    }, { tenantId });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const sendableToken = createFeedbackToken({ tenantId, runId, rating: 'sendable' }, sessionSecret);
    const sendable = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(sendableToken)}`);
    assert.equal(sendable.status, 200);
    assert.equal(sentMails.length, 0);

    const correctionToken = createFeedbackToken({ tenantId, runId, rating: 'minor_correction' }, sessionSecret);
    const correction = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(correctionToken)}`);
    assert.equal(correction.status, 200);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'ventocamp@gmail.com');
    assert.match(sentMails[0].subject, /Daltec Korrektur nötig - Michael Proof/);
    assert.match(sentMails[0].html, /manual correction required/);
    assert.match(sentMails[0].html, /Customer-Send ist blockiert/);
    assert.match(sentMails[0].html, /kunde@example\.at/);
    assert.match(sentMails[0].html, /Cargo-Hochlader 311x160/);
    assert.match(sentMails[0].html, new RegExp(runId));
    assert.match(sentMails[0].html, /Eduard Anfrage Notification Proof/);
    assert.match(sentMails[0].html, /https:\/\/angebote\.daltec\.at\/\?run=/);

    const updated = await loadOfferRun(runId, { tenantId });
    assert.equal(updated.summary.needsManualCorrection, true);
    assert.equal(updated.owner_feedback.rating, 'minor_correction');
    assert.equal(updated.events.some((event) => event.event_type === 'owner_feedback_recorded'), true);
    const sentEvent = updated.events.find((event) => event.event_type === 'owner_feedback_notification_sent');
    assert.ok(sentEvent);
    assert.equal(sentEvent.metadata_json.customerEmail, 'kunde@example.at');
    assert.equal(sentEvent.metadata_json.firstPosition, 'Cargo-Hochlader 311x160');

    const repeatedCorrection = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(correctionToken)}`);
    assert.equal(repeatedCorrection.status, 200);
    assert.equal(sentMails.length, 1);
    const repeated = await loadOfferRun(runId, { tenantId });
    assert.equal(repeated.owner_feedback.rating, 'minor_correction');
    assert.equal(repeated.events.some((event) => event.event_type === 'owner_feedback_notification_skipped'), true);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public manual correction feedback records failed internal notification', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'manual-correction-notify-failed-secret';
  const tenantId = `manual-correction-notify-failed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previousEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    DATABASE_URL: process.env.DATABASE_URL
  };
  process.env.APP_BASE_URL = 'https://angebote.daltec.at';
  delete process.env.DATABASE_URL;
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'manual_correction_notify_failed_session',
      secureCookie: false
    },
    mailRuntimeFactory: async () => ({
      provider: 'test',
      client: null,
      sendHtmlMail: async () => {
        throw new Error('notification transport unavailable');
      }
    })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const inbound = await ingestInboundMessage({
      provider: 'manual_test',
      provider_message_id: `manual-correction-notify-failed-${Date.now()}`,
      subject: 'Eduard Anfrage Notification Failure Proof',
      from_email: 'kunde@example.at',
      raw_html: '<table><tr><td>Hochlader 3318</td><td>3000</td></tr></table>',
      raw_text: ''
    }, { tenantId });
    const runId = inbound.run.id;
    await updateOfferRun(runId, {
      status: 'completed',
      draft_subject: 'Angebot Notification Failure Proof',
      draft_html: '<p>Angebot</p>',
      customer_json: { first_name: 'Michael', last_name: 'Failure', email: 'kunde@example.at' },
      summary: { customerName: 'Michael Failure', customerEmail: 'kunde@example.at', editable_offer_version: 1 }
    }, { tenantId });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const correctionToken = createFeedbackToken({ tenantId, runId, rating: 'minor_correction' }, sessionSecret);
    const correction = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(correctionToken)}`);
    assert.equal(correction.status, 200);

    const updated = await loadOfferRun(runId, { tenantId });
    assert.equal(updated.summary.needsManualCorrection, true);
    assert.equal(updated.owner_feedback.rating, 'minor_correction');
    assert.equal(updated.events.some((event) => event.event_type === 'owner_feedback_recorded'), true);
    const failedEvent = updated.events.find((event) => event.event_type === 'owner_feedback_notification_failed');
    assert.ok(failedEvent);
    assert.equal(failedEvent.level, 'warning');
    assert.equal(failedEvent.message, 'notification transport unavailable');
    assert.equal(failedEvent.metadata_json.to, 'ventocamp@gmail.com');
    assert.match(failedEvent.metadata_json.reviewLink, /https:\/\/angebote\.daltec\.at\/\?run=/);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public manual correction notification failure keeps feedback saved', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'manual-correction-notify-failure-secret';
  const tenantId = `manual-correction-notify-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previousEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    DATABASE_URL: process.env.DATABASE_URL
  };
  process.env.APP_BASE_URL = 'https://angebote.daltec.at';
  delete process.env.DATABASE_URL;
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'manual_correction_notify_failure_session',
      secureCookie: false
    },
    mailRuntimeFactory: async () => ({
      provider: 'test',
      client: null,
      sendHtmlMail: async () => {
        throw new Error('smtp_unavailable_for_test');
      }
    })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const inbound = await ingestInboundMessage({
      provider: 'manual_test',
      provider_message_id: `manual-correction-notify-failure-${Date.now()}`,
      subject: 'Eduard Anfrage Notification Failure Proof',
      from_email: 'kunde@example.at',
      raw_html: '<table><tr><td>Hochlader 3318</td><td>3000</td></tr></table>',
      raw_text: ''
    }, { tenantId });
    const runId = inbound.run.id;
    await updateOfferRun(runId, {
      status: 'completed',
      draft_subject: 'Angebot Notification Failure Proof',
      draft_html: '<p>Angebot</p>',
      customer_json: { first_name: 'Failure', last_name: 'Proof', email: 'kunde@example.at' },
      summary: { customerName: 'Failure Proof', customerEmail: 'kunde@example.at', editable_offer_version: 1 }
    }, { tenantId });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const correctionToken = createFeedbackToken({ tenantId, runId, rating: 'minor_correction' }, sessionSecret);
    const correction = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(correctionToken)}`);
    assert.equal(correction.status, 200);
    assert.match(await correction.text(), /Feedback gespeichert/);

    const updated = await loadOfferRun(runId, { tenantId });
    assert.equal(updated.summary.needsManualCorrection, true);
    assert.equal(updated.owner_feedback.rating, 'minor_correction');
    assert.equal(updated.events.some((event) => event.event_type === 'owner_feedback_recorded'), true);
    assert.equal(updated.events.some((event) => event.event_type === 'owner_feedback_notification_failed'), true);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('microsoft oauth start redirects and callback stores tenant token', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'microsoft-session-secret';
  const previousEnv = {
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI,
    APP_BASE_URL: process.env.APP_BASE_URL,
    TENANT_HOST_MAP: process.env.TENANT_HOST_MAP
  };
  const tenantId = `ms-oauth-${Date.now()}`;
  process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'ms-client-secret';
  process.env.MICROSOFT_REDIRECT_URI = 'http://127.0.0.1:3030/api/oauth/microsoft/callback';
  process.env.APP_BASE_URL = 'http://127.0.0.1:3030';
  process.env.TENANT_HOST_MAP = `oauth.example.at=${tenantId}`;

  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'ms_session',
      secureCookie: false
    },
    microsoftOAuth: {
      exchangeCode: async (config, code) => {
        if (code !== 'valid-code') {
          const error = new Error('microsoft_token_failed: invalid_grant');
          error.statusCode = 400;
          throw error;
        }
        assert.equal(config.microsoft.redirectUri, 'http://127.0.0.1:3030/api/oauth/microsoft/callback');
        return {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer'
        };
      },
      fetchProfile: async (token) => {
        assert.equal(token.access_token, 'access-token');
        return { email: 'owner@example.com' };
      }
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'oauth.example.at' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const start = await fetch(`${baseUrl}/api/oauth/microsoft/start`, {
      redirect: 'manual',
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'oauth.example.at' }
    });
    assert.equal(start.status, 302);
    const location = start.headers.get('location');
    assert.match(location, /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/);
    const authUrl = new URL(location);
    assert.equal(authUrl.searchParams.get('client_id'), 'ms-client-id');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:3030/api/oauth/microsoft/callback');
    assert.deepEqual(authUrl.searchParams.get('scope').split(' ').sort(), ['Mail.Read', 'Mail.Send', 'offline_access'].sort());

    const callback = await fetch(`${baseUrl}/api/oauth/microsoft/callback?code=valid-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`, {
      redirect: 'manual',
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'oauth.example.at' }
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/?mail_connected=outlook');

    const storedPath = path.join('data', 'tenants', tenantId, 'mail-connections.json');
    const stored = JSON.parse(await fs.readFile(storedPath, 'utf8'));
    assert.equal(stored.outlook.token.refresh_token, 'refresh-token');
    assert.equal(stored.outlook.profile.email, 'owner@example.com');

    const bad = await fetch(`${baseUrl}/api/oauth/microsoft/callback?code=bad-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`, {
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'oauth.example.at' }
    });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /microsoft_token_failed/);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('imap connect stores settings and disconnect removes credentials', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const tenantId = `imap-api-${Date.now()}`;
  const previousHostMap = process.env.TENANT_HOST_MAP;
  process.env.TENANT_HOST_MAP = `imap.example.at=${tenantId}`;
  const pollerEvents = [];
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret: 'imap-session-secret',
      cookieName: 'imap_session',
      secureCookie: false
    },
    imap: {
      testConnection: async (imap) => {
        if (imap.app_password !== 'correct-app-password') {
          const error = new Error('imap_auth_failed');
          error.statusCode = 401;
          throw error;
        }
      },
      startTenant: (tenantIdForStart) => pollerEvents.push(['start', tenantIdForStart]),
      stopTenant: (tenantIdForStop) => pollerEvents.push(['stop', tenantIdForStop])
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'imap.example.at' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const bad = await fetch(`${baseUrl}/api/tenant/${tenantId}/imap/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-Host': 'imap.example.at' },
      body: JSON.stringify({ email: 'anfragen@drei.at', app_password: 'wrong-app-password' })
    });
    assert.equal(bad.status, 401);
    const badText = await bad.text();
    assert.match(badText, /imap_auth_failed/);
    assert.match(badText, /imap\.drei\.at/);

    const connected = await fetch(`${baseUrl}/api/tenant/${tenantId}/imap/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-Host': 'imap.example.at' },
      body: JSON.stringify({ email: 'anfragen@drei.at', app_password: 'correct-app-password' })
    });
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), { ok: true, active: true });
    assert.deepEqual(pollerEvents, [['start', tenantId]]);

    const settingsPath = path.join('data', 'tenants', tenantId, 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(settings.imap.email, 'anfragen@drei.at');
    assert.equal(settings.imap.app_password, 'correct-app-password');
    assert.equal(settings.imap.host, 'imap.drei.at');

    const disconnected = await fetch(`${baseUrl}/api/tenant/${tenantId}/imap/disconnect`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-Forwarded-Host': 'imap.example.at' }
    });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { ok: true, active: false });
    assert.deepEqual(pollerEvents, [['start', tenantId], ['stop', tenantId]]);

    const afterDisconnect = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(afterDisconnect.imap, undefined);
  } finally {
    if (previousHostMap === undefined) delete process.env.TENANT_HOST_MAP;
    else process.env.TENANT_HOST_MAP = previousHostMap;
    await fs.rm(path.join('data', 'tenants', tenantId), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review draft html composer preserves n8n table styling and edited prices', () => {
  const html = buildEditedDraftHtml({
    intro: 'Sehr geehrter Herr Test,\n\nvielen Dank.',
    tables: [{
      title: 'WUNSCH-KONFIGURATION',
      rows: [
      { product: 'Geänderter Hochlader', uvp: '€ 2.720,83', discount: '€ 345,83', offer: '€ 2.375,00' },
      { product: 'Gesamt netto', uvp: '€ 2.720,83', discount: '€ 345,83', offer: '€ 2.375,00', type: 'total' },
      { product: '20% Mehrwertsteuer', uvp: '€ 544,17', discount: '€ 69,17', offer: '€ 475,00', type: 'vat' },
      { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 3.265,00', discount: '€ 415,00', offer: '€ 2.850,00', type: 'gross' }
      ]
    }],
    notes: 'Bearbeiteter Hinweis',
    signature: 'Beste Grüße\nLukas'
  });

  assert.match(html, /Geänderter Hochlader/);
  assert.match(html, /€ 2\.850,00/);
  assert.match(html, /UVP Netto/);
  assert.match(html, /Rabatt/);
  assert.match(html, /Angebot Netto/);
  assert.doesNotMatch(html, /UVP brutto|Angebot brutto/);
  assert.match(html, /width:100%;box-sizing:border-box;text-align:center;background-color:#ffffff;padding:20px 0/);
  assert.match(html, /max-width:760px;width:100%;box-sizing:border-box;margin:0 auto;text-align:left;overflow-wrap:break-word/);
  assert.match(html, /table role="presentation" cellspacing="0" cellpadding="0" border="0"/);
  assert.match(html, /border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1\.4;color:#000;width:100%;max-width:760px;box-sizing:border-box;margin:0 auto 22px auto;table-layout:fixed/);
  assert.match(html, /box-sizing:border-box;text-align:left;vertical-align:top;word-break:break-word/);
  assert.match(html, /box-sizing:border-box;text-align:left;width:40%/);
  assert.match(html, /box-sizing:border-box;text-align:center;width:20%/);
  assert.match(html, /box-sizing:border-box;text-align:center;width:18%/);
  assert.match(html, /box-sizing:border-box;text-align:center;width:22%/);
  assert.match(html, /background:#F2B400;font-weight:bold;color:#000/);
  assert.match(html, /border:1px solid #222222/);
  assert.match(html, /20% Mehrwertsteuer/);
  assert.match(html, /color:#c00000;font-weight:bold/);
  assert.match(html, /font-family:Arial,sans-serif;font-size:14px/);
  assert.match(html, /Bearbeiteter Hinweis/);
  assert.match(html, /border:1px solid #d3d3d3;background:#fafafa;padding:18px 20px;box-sizing:border-box/);
});

test('review draft html composer uses tenant offer table color', () => {
  const html = buildEditedDraftHtml({
    tables: [{
      title: 'WUNSCH-KONFIGURATION',
      rows: [
        { product: 'Hochlader', uvp: '€ 2.000,00', discount: '€ 227,20', offer: '€ 1.772,80' },
        { product: 'Gesamt netto', uvp: '€ 2.000,00', discount: '€ 227,20', offer: '€ 1.772,80', type: 'total' },
        { product: '20% MwSt.', uvp: '€ 400,00', discount: '€ 45,44', offer: '€ 354,56', type: 'vat' },
        { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 2.400,00', discount: '€ 272,64', offer: '€ 2.127,36', type: 'gross' }
      ]
    }],
    settings: { theme: { offerTableHeaderBg: '#f7b500' } }
  });

  assert.match(html, /background:#F7B500;font-weight:bold;color:#000/);
  assert.match(html, /20% Mehrwertsteuer/);
  assert.match(html, /Gesamt Brutto \(inkl\. MwSt\.\)/);
  assert.doesNotMatch(html, /background:#F2B400;font-weight:bold;color:#000/);
});

test('review draft html composer never renders NaN for empty price fields', () => {
  const html = buildEditedDraftHtml({
    rows: [
      { product: 'Leer', uvp: '', discount: '', offer: '' },
      { product: 'Gesamt netto', uvp: '€ 0,00', discount: '€ 0,00', offer: '€ 0,00', type: 'total' },
      { product: '20% Mehrwertsteuer', uvp: '€ 0,00', discount: '€ 0,00', offer: '€ 0,00', type: 'vat' },
      { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 0,00', discount: '€ 0,00', offer: '€ 0,00', type: 'gross' }
    ]
  });
  assert.doesNotMatch(html, /NaN/);
});

test('review preview without upsell renders one pricing table', () => {
  const html = buildEditedDraftHtml({
    intro: 'Sehr geehrte Damen und Herren',
    rows: [
      { product: 'Wunsch Hochlader', uvp: '€ 2.000,00', discount: '€ 100,00', offer: '€ 1.900,00' },
      { product: 'Gesamt netto', uvp: '€ 2.000,00', discount: '€ 100,00', offer: '€ 1.900,00', type: 'total' },
      { product: '20% MwSt', uvp: '€ 400,00', discount: '€ 20,00', offer: '€ 380,00', type: 'vat' },
      { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 2.400,00', discount: '€ 120,00', offer: '€ 2.280,00', type: 'gross' }
    ]
  });

  assert.equal((html.match(/<table role="presentation"/g) || []).length, 1);
  assert.doesNotMatch(html, /SOFORT AB LAGER VERF/);
});

test('review preview with upsell renders two pricing tables from same mail html source', () => {
  const html = buildEditedDraftHtml({
    intro: 'Sehr geehrte Damen und Herren',
    tables: [
      {
        title: 'WUNSCH-KONFIGURATION',
        rows: [
          { product: 'Wunsch Hochlader', uvp: '€ 2.000,00', discount: '€ 100,00', offer: '€ 1.900,00' },
          { product: 'Gesamt netto', uvp: '€ 2.000,00', discount: '€ 100,00', offer: '€ 1.900,00', type: 'total' },
          { product: '20% MwSt', uvp: '€ 400,00', discount: '€ 20,00', offer: '€ 380,00', type: 'vat' },
          { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 2.400,00', discount: '€ 120,00', offer: '€ 2.280,00', type: 'gross' }
        ]
      },
      {
        title: 'SOFORT AB LAGER VERFÜGBAR',
        intro: 'Passendes Lagerfahrzeug: Lager Hochlader',
        rows: [
          { product: 'Lager Hochlader', uvp: '€ 2.100,00', discount: '€ 150,00', offer: '€ 1.950,00' },
          { product: 'Gesamt netto', uvp: '€ 2.100,00', discount: '€ 150,00', offer: '€ 1.950,00', type: 'total' },
          { product: '20% MwSt', uvp: '€ 420,00', discount: '€ 30,00', offer: '€ 390,00', type: 'vat' },
          { product: 'Gesamt Brutto (inkl. MwSt.)', uvp: '€ 2.520,00', discount: '€ 180,00', offer: '€ 2.340,00', type: 'gross' }
        ]
      }
    ]
  });

  assert.equal((html.match(/<table role="presentation"/g) || []).length, 2);
  assert.match(html, /WUNSCH-KONFIGURATION/);
  assert.match(html, /SOFORT AB LAGER VERFÜGBAR/);
  assert.match(html, /Lager Hochlader/);
  assert.match(html, /background:#F2B400;font-weight:bold;color:#000/);
});

test('review UI source contains prefilled fields spinner and success state hooks', async () => {
  const serverSource = await fs.readFile(path.join('src', 'admin', 'server.js'), 'utf8');
  const appSource = await fs.readFile(path.join('src', 'admin', 'public', 'app.js'), 'utf8');
  const htmlSource = await fs.readFile(path.join('src', 'admin', 'public', 'index.html'), 'utf8');
  const stylesSource = await fs.readFile(path.join('src', 'admin', 'public', 'styles.css'), 'utf8');
  const ownerSource = await fs.readFile(path.join('src', 'owner-delivery.js'), 'utf8');
  assert.match(appSource, /data-draft-field="to" type="email" value="\$\{escapeHtml\(draft\.to\)\}"/);
  assert.match(appSource, /data-copy-customer-email/);
  assert.match(appSource, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(appSource, /document\.execCommand\('copy'\)/);
  assert.match(appSource, /Kopiert!/);
  assert.match(stylesSource, /\.customer-email-copy/);
  assert.match(stylesSource, /background: #f4f4f4/);
  assert.match(stylesSource, /border: 1px solid #bbb/);
  assert.match(stylesSource, /user-select: all/);
  assert.match(appSource, /data-draft-field="subject" type="text" value="\$\{escapeHtml\(draft\.subject\)\}"/);
  assert.match(appSource, /data-price-field="offerNet" type="text" inputmode="decimal"/);
  assert.match(appSource, /data-price-field="discount" type="text"/);
  assert.match(appSource, /parseMoney\(.*\) \|\| 0/);
  assert.match(appSource, /<table class="editable-price-table" data-draft-table>/);
  assert.match(appSource, /recalculateDraftTotals\(form\)/);
  assert.match(appSource, /data-calculated-row/);
  assert.match(appSource, /data-draft-field="notes"/);
  assert.match(appSource, /data-delete-draft-row/);
  assert.match(appSource, /data-add-draft-row/);
  assert.match(appSource, /addDraftItemRow\(form\)/);
  assert.match(appSource, /button\.textContent = 'Sendet\.\.\.'/);
  assert.match(appSource, /draft-message ok/);
  assert.match(appSource, /send-to-customer/);
  assert.match(appSource, /form\.addEventListener\('input', \(event\) => handleDraftReviewInput\(event, form\)\)/);
  assert.match(appSource, /sanitizeMoneyInput\(input\)/);
  assert.doesNotMatch(appSource, /syncGrossNetPair\(row, fieldBase, source\)/);
  assert.doesNotMatch(appSource, /data-toggle-price-mode/);
  assert.match(appSource, /data-price-field="offerNet"/);
  assert.doesNotMatch(appSource, /data-price-field="uvpGross"/);
  assert.match(appSource, /readonly aria-readonly="true"/);
  assert.doesNotMatch(appSource, /import \\{ buildEditedDraftHtml \\}/);
  assert.doesNotMatch(appSource, /buildEditedDraftHtml/);
  assert.doesNotMatch(appSource, /previewFrame\\.srcdoc = buildEditedDraftPayload\\(form\\)\\.html/);
  assert.match(appSource, /\/render-editable-offer/);
  assert.match(appSource, /editableOfferRenderSequence/);
  assert.match(appSource, /previewStateLabel\.textContent = 'Draft'/);
  assert.match(appSource, /data-draft-extra-tables/);
  assert.match(appSource, /data-inventory-alternative-toggle/);
  assert.match(appSource, /editable_offer/);
  assert.match(appSource, /\/editable-offer/);
  assert.match(appSource, /Mail-Vorschau f&uuml;r H&auml;ndler anzeigen/);
  assert.match(appSource, /Dauerhaft anpassbar/);
  assert.match(appSource, /Nur lesend/);
  assert.match(appSource, /data-readonly-source="catalog"/);
  assert.match(appSource, /Alternative ersetzen/);
  assert.match(appSource, /data-inventory-replacement-enabled/);
  assert.match(appSource, /data-inventory-replacement-field="inventory_name"/);
  assert.match(appSource, /data-inventory-replacement-field="reason"/);
  assert.match(appSource, /replacementFromForm\(form\)/);
  assert.match(appSource, /to: form\.querySelector\('\[data-draft-field="to"\]'\)\.value\.trim\(\)/);
  assert.match(appSource, /subject: form\.querySelector\('\[data-draft-field="subject"\]'\)\.value\.trim\(\)/);
  assert.match(appSource, /intro: form\.querySelector\('\[data-draft-field="intro"\]'\)\.value/);
  assert.match(appSource, /rows: editableRowsFromForm\(form\)/);
  assert.match(appSource, /extra_tables: draftExtraTablesFromForm\(form\)/);
  assert.match(appSource, /notes: form\.querySelector\('\[data-draft-field="notes"\]'\)\.value/);
  assert.match(appSource, /signature: form\.querySelector\('\[data-draft-field="signature"\]'\)\.value/);
  assert.doesNotMatch(appSource, /import \\{ buildEditedDraftHtml \\}/);
  assert.doesNotMatch(appSource, /buildEditedDraftHtml/);
  assert.doesNotMatch(appSource, /function mailInputFromEditableOffer\(editableOffer\)/);
  assert.doesNotMatch(appSource, /previewFrame\\.srcdoc = buildEditedDraftPayload\\(form\\)\\.html/);
  assert.match(appSource, /\/api\/offer-runs\/\$\{encodeURIComponent\(runId\)\}\/review-state/);
  assert.match(appSource, /const draft = options\.reviewState \|\| draftReviewState\(run\)/);
  assert.match(appSource, /previewFrame\.srcdoc = result\.html/);
  assert.match(appSource, /\/render-editable-offer/);
  assert.match(serverSource, /app\.get\('\/api\/offer-runs\/:id\/review-state'/);
  assert.match(serverSource, /buildReviewStateForRun\(run, editableOfferStateWithContentDefaults\(run, \{\}, settings\), settings\)/);
  assert.match(appSource, /--offer-table-header-bg:/);
  assert.match(appSource, /draft\.theme\?\.offerTableHeaderBg/);
  assert.match(stylesSource, /background: var\(--offer-table-header-bg, #F2B400\)/);
  assert.match(serverSource, /const cc = settings\.mail\?\.cc \|\| config\.gmail\.cc \|\| ''/);
  assert.match(serverSource, /sendHtmlMail\(runtime\.client,\s*\{[\s\S]*to: draft\.to,[\s\S]*cc,[\s\S]*subject: draft\.subject,[\s\S]*html: finalHtml[\s\S]*\}\)/);
  assert.match(serverSource, /metadata: \{ to: draft\.to, cc, subject: draft\.subject, provider: runtime\.provider \|\| 'unknown' \}/);
  assert.match(appSource, /editableOfferRenderSequence/);
  assert.match(appSource, /request\(`\/api\/offer-runs\/\$\{encodeURIComponent\(runId\)\}\/send-to-customer`/);
  assert.match(appSource, /Manuelle Korrektur nötig/);
  assert.match(appSource, /needsManualCorrection/);
  assert.match(stylesSource, /\.review-flags\.manual-correction/);
  assert.match(serverSource, /manual_correction_required/);
  assert.match(ownerSource, /Bitte kurz entscheiden/);
  assert.match(ownerSource, /\['sendable', 'Sendbar - kann raus'\]/);
  assert.match(ownerSource, /\['minor_correction', 'Korrektur nötig - bitte prüfen'\]/);
  assert.doesNotMatch(ownerSource, /\['wrong', 'Falsch'\]/);
  assert.match(htmlSource, /id="inbound-status-list"/);
  assert.match(appSource, /const inboundStatusListEl = document\.querySelector\('#inbound-status-list'\)/);
  assert.match(appSource, /request\('\/api\/inbound-status\?limit=25'\)/);
  assert.match(appSource, /function inboundStatusItemHtml\(item\)/);
  assert.match(appSource, /data-run-id="\$\{escapeHtml\(item\.runId\)\}"/);
});

test('onboarding source wires production self-service steps', async () => {
  const serverSource = await fs.readFile(path.join('src', 'admin', 'server.js'), 'utf8');
  const htmlSource = await fs.readFile(path.join('src', 'admin', 'public', 'onboarding', 'index.html'), 'utf8');
  const jsSource = await fs.readFile(path.join('src', 'admin', 'public', 'onboarding', 'onboarding.js'), 'utf8');
  const appSource = await fs.readFile(path.join('src', 'admin', 'public', 'app.js'), 'utf8');

  assert.match(serverSource, /res\.redirect\('\/onboarding\?mail_connected=gmail'\)/);
  assert.match(htmlSource, /Eduard-Mails weiterleiten/);
  assert.match(htmlSource, /Ersten Draft simulieren/);
  assert.match(jsSource, /sampleCsvDownload\.href = '\/api\/sample-csv'/);
  assert.match(jsSource, /Gmail verbunden:/);
  assert.match(jsSource, /\/api\/inbound\/email/);
  assert.match(jsSource, /onboarding_test/);
  assert.match(appSource, /isOnboardingTestRun/);
  assert.match(appSource, /Senden ist deaktiviert/);
});

test('legacy run without editable offer exposes review-state fallback', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret: 'editable-seed-session-secret',
      cookieName: 'editable_seed_session',
      secureCookie: false
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    const leadToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inbound = await fetch(`${baseUrl}/api/inbound/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'gmail',
        provider_message_id: `editable-seed-${leadToken}`,
        subject: 'Eduard Anfrage',
        from_email: `kunde-${leadToken}@example.at`,
        received_at: new Date().toISOString(),
        raw_html: `
          <table>
            <tr><td><strong>Vorname</strong></td><td>Eva</td></tr>
            <tr><td><strong>Nachname</strong></td><td>Seed</td></tr>
            <tr><td><strong>E-mail-Adresse</strong></td><td>seed-${leadToken}@example.at</td></tr>
            <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
          </table>`
      })
    });
    assert.equal(inbound.status, 201);
    const inboundBody = await inbound.json();

    const processed = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/process`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(processed.status, 200);

    const detail = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();

    const legacySummary = { ...detailBody.summary };
    delete legacySummary.editable_offer;
    await updateOfferRun(inboundBody.offer_run_id, { summary: legacySummary }, { tenantId: 'daltec-local' });

    const legacyDetail = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(legacyDetail.status, 200);
    const legacyDetailBody = await legacyDetail.json();
    assert.equal(legacyDetailBody.summary.editable_offer, undefined);

    const reviewState = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/review-state`, {
      headers: { Cookie: cookie }
    });
    const body = await reviewState.json();
    assert.equal(reviewState.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.version, 1);
    assert.equal(body.to, `seed-${leadToken}@example.at`);
    assert.match(body.subject, /Eduard Angebot/);
    assert.equal(typeof body.intro, 'string');
    assert.equal(typeof body.notes, 'string');
    assert.equal(typeof body.signature, 'string');
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.rows.length > 0);
    assert.ok(Array.isArray(body.extra_tables));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.skip('review send-to-customer endpoint validates sends edited draft and marks run sent', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sentMails = [];
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret: 'send-session-secret',
      cookieName: 'send_session',
      secureCookie: false
    },
    mailRuntimeFactory: async () => ({
      provider: 'test',
      client: {},
      sendHtmlMail: async (client, message) => sentMails.push(message)
    })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const leadToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inboundPayload = {
      provider: 'gmail',
      provider_message_id: `send-flow-${leadToken}`,
      subject: 'Eduard Anfrage',
      from_email: `kunde-${leadToken}@example.at`,
      received_at: new Date().toISOString(),
      raw_html: `
        <table>
          <tr><td><strong>Vorname</strong></td><td>Eva</td></tr>
          <tr><td><strong>Nachname</strong></td><td>Kunde</td></tr>
          <tr><td><strong>E-mail-Adresse</strong></td><td>eva-${leadToken}@example.at</td></tr>
          <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        </table>`
    };
    const inbound = await fetch(`${baseUrl}/api/inbound/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(inboundPayload)
    });
    assert.equal(inbound.status, 201);
    const inboundBody = await inbound.json();

    const processed = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/process`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(processed.status, 200);

    const ssot = await fetch(`${baseUrl}/api/debug/offer-runs/${inboundBody.offer_run_id}/ssot-check`, {
      headers: { Cookie: cookie }
    });
    assert.equal(ssot.status, 200);
    const ssotBody = await ssot.json();
    assert.equal(ssotBody.ok, true);
    assert.equal(ssotBody.review.tableCount, ssotBody.preview.tableCount);
    assert.equal(ssotBody.preview.tableCount, ssotBody.mail.tableCount);
    assert.equal(ssotBody.inventoryAlternativeRules.sendFlowRule.includes('must not re-enable'), true);

    const missingTo = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ subject: 'Bearbeitetes Eduard Angebot', html: '<p>Hallo</p>' })
    });
    assert.equal(missingTo.status, 400);
    assert.deepEqual(await missingTo.json(), { ok: false, error: 'to_required' });

    const missingHtml = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ to: 'edited@example.at', subject: 'Bearbeitetes Eduard Angebot' })
    });
    assert.equal(missingHtml.status, 400);
    assert.deepEqual(await missingHtml.json(), { ok: false, error: 'editable_offer_required' });

    const editableOffer = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/editable-offer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        version: 1,
        editable_offer: {
          to: 'persisted@example.at',
          subject: 'Persistiertes Angebot',
          intro: 'Persistiertes Intro',
          rows: [{ type: 'item', product: 'Persistierter Hochlader', uvpNet: '3000,00', discount: '300,00', offerNet: '2700,00' }],
          extra_tables: [],
          notes: 'Persistierter Hinweis',
          signature: 'Persistierte Signatur',
          inventory_alternative: { enabled: false }
        }
      })
    });
    assert.equal(editableOffer.status, 200);
    const editableOfferBody = await editableOffer.json();
    assert.equal(editableOfferBody.ok, true);
    assert.equal(editableOfferBody.version, 2);
    assert.equal(editableOfferBody.editable_offer.inventory_alternative.enabled, false);
    assert.equal(editableOfferBody.editable_offer.to, 'persisted@example.at');
    assert.equal(editableOfferBody.editable_offer.subject, 'Persistiertes Angebot');
    assert.equal(editableOfferBody.editable_offer.intro, 'Persistiertes Intro');
    assert.equal(editableOfferBody.editable_offer.rows[0].product, 'Persistierter Hochlader');
    assert.deepEqual(editableOfferBody.editable_offer.extra_tables, []);
    assert.equal(editableOfferBody.editable_offer.notes, 'Persistierter Hinweis');
    assert.equal(editableOfferBody.editable_offer.signature, 'Persistierte Signatur');

    const stalePatchPayload = {
      version: editableOfferBody.version,
      editable_offer: {
        ...editableOfferBody.editable_offer,
        intro: 'Parallel gespeicherter Text'
      }
    };
    const firstPatch = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/editable-offer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(stalePatchPayload)
    });
    assert.equal(firstPatch.status, 200);
    const successfulPatchBody = await firstPatch.json();
    assert.equal(successfulPatchBody.version, 3);
    const stalePatch = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/editable-offer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(stalePatchPayload)
    });
    assert.equal(stalePatch.status, 409);
    const conflictBody = await stalePatch.json();
    assert.equal(conflictBody.ok, false);
    assert.equal(conflictBody.error, 'editable_offer_conflict');
    assert.equal(conflictBody.current_version, 3);
    assert.equal(conflictBody.editable_offer.intro, 'Parallel gespeicherter Text');
    const editedHtml = [
      '<div style="font-family:Arial;font-size:14px;">',
      '<p>Sehr geehrte Frau Kunde, hier ist das bearbeitete Angebot.</p>',
      '<table style="border-collapse:collapse;font-family:Arial;font-size:14px;">',
      '<tr style="background:#F2B400;font-weight:bold;color:#000;"><th style="border:1px solid #222222;">Produkt</th><th style="border:1px solid #222222;">UVP</th><th style="border:1px solid #222222;color:#c00000;">Rabatt</th><th style="border:1px solid #222222;">Angebot</th></tr>',
      '<tr><td style="border:1px solid #222222;">Bearbeiteter Hochlader</td><td style="border:1px solid #222222;">€ 3.600,00</td><td style="border:1px solid #222222;color:#c00000;font-weight:bold;">€ 410,00</td><td style="border:1px solid #222222;">€ 3.190,00</td></tr>',
      '<tr style="background:#F2B400;font-weight:bold;"><td style="border:1px solid #222222;">Gesamt brutto</td><td style="border:1px solid #222222;">€ 3.600,00</td><td style="border:1px solid #222222;color:#c00000;">€ 410,00</td><td style="border:1px solid #222222;">€ 3.190,00</td></tr>',
      '</table><p>Hinweis nach Bearbeitung.</p><p>Beste Grüße<br>Lukas Mitter</p></div>'
    ].join('');

    const sendPayload = {
      to: 'edited@example.at',
      subject: 'Bearbeitetes Eduard Angebot',
      html: '<p>STALE BODY HTML MUST NOT BE SENT</p>',
      editable_offer: {
        to: 'edited@example.at',
        subject: 'Bearbeitetes Eduard Angebot',
        intro: 'Sehr geehrte Frau Kunde, hier ist das bearbeitete Angebot.',
        rows: [{ type: 'item', product: 'Bearbeiteter Hochlader', uvpNet: '3000,00', discount: '300,00', offerNet: '2700,00' }],
        extra_tables: [],
        notes: 'Hinweis nach Bearbeitung.',
        signature: 'Beste Gr\u00fc\u00dfe\nLukas Mitter',
        inventory_alternative: { enabled: false }
      }
    };

    const send = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(sendPayload)
    });
    assert.equal(send.status, 200);

    const secondSend = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(sendPayload)
    });
    assert.equal(secondSend.status, 409);
    assert.deepEqual(await secondSend.json(), { ok: false, error: 'run_not_sendable' });

    const patchAfterSend = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/editable-offer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        version: successfulPatchBody.version,
        editable_offer: {
          ...sendPayload.editable_offer,
          intro: 'Darf nach Versand nicht mehr speichern.'
        }
      })
    });
    assert.equal(patchAfterSend.status, 409);
    assert.deepEqual(await patchAfterSend.json(), { ok: false, error: 'run_finalized' });
    assert.equal(send.status, 200);
    const sendBody = await send.json();
    assert.equal(sendBody.ok, true);
    assert.match(sendBody.sent_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'edited@example.at');
    assert.equal(sentMails[0].subject, 'Bearbeitetes Eduard Angebot');
    assert.match(sentMails[0].html, /Bearbeiteter Hochlader/);
    assert.doesNotMatch(sentMails[0].html, /STALE BODY HTML/);
    assert.equal((sentMails[0].html.match(/<table/g) || []).length, 1);
    assert.match(sentMails[0].html, /Hinweis nach Bearbeitung/);
    assert.match(sentMails[0].html, /Beste Grüße/);

    const detail = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}`, {
      headers: { Cookie: cookie }
    });
    const detailBody = await detail.json();
    assert.equal(detailBody.status, 'sent_to_customer');
    assert.equal(detailBody.draft_html, sentMails[0].html);
    assert.equal(detailBody.summary.editable_offer.inventory_alternative.enabled, false);
    assert.equal(detailBody.summary.editable_offer.to, 'edited@example.at');
    assert.equal(detailBody.summary.editable_offer.subject, 'Bearbeitetes Eduard Angebot');
    assert.match(detailBody.summary.editable_offer.rows[0].product, /Bearbeiteter Hochlader/);
    assert.equal(detailBody.events.some((event) => event.event_type === 'sent_to_customer'), true);
    assert.equal(detailBody.events.some((event) => event.event_type === 'editable_offer_updated'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.skip('admin API requires login session', async () => {
  const passwordHash = createPasswordHash('secret-pass');
  const sessionSecret = 'test-session-secret';
  const previousIngestSecret = process.env.EDUARD_INGEST_SECRET;
  process.env.EDUARD_INGEST_SECRET = 'test-ingest-secret';
  const app = createAdminApp({
    auth: {
      email: 'owner@example.com',
      secret: passwordHash,
      sessionSecret,
      cookieName: 'test_session',
      secureCookie: false
    },
    gmailProofAnalyzer: async (options) => {
      assert.equal(options.tenantId, 'daltec-local');
      return {
        query: 'subject:Eduard',
        limit: Number(options.limit || 50),
        messageCount: 1,
        productNameCount: 1,
        productsByCategory: {
          anhaenger: [{ name: 'Hochlader 3318 3500kg', category: 'anhaenger', count: 1 }]
        },
        messages: [{
          providerMessageId: 'gmail-proof-1',
          subject: 'Eduard Anfrage',
          fromDomain: 'example.com',
          receivedAt: new Date().toISOString(),
          customerDetected: true,
          productCount: 1,
          products: [{ name: 'Hochlader 3318 3500kg', category: 'anhaenger', price: 3000 }]
        }]
      };
    }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const blocked = await fetch(`${baseUrl}/api/settings`);
    assert.equal(blocked.status, 401);

    const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'bad' })
    });
    assert.equal(failedLogin.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /test_session=/);

    const allowed = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: cookie }
    });
    assert.equal(allowed.status, 200);

    const invalidSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        pricing: {
          discountPercent: 2434,
          roundTo: 123,
          vatRate: 0.2,
          offerFactor: 0.87,
          inventoryFallbackMarkupPercent: 0
        }
      })
    });
    assert.equal(invalidSettings.status, 400);
    const invalidSettingsBody = await invalidSettings.json();
    assert.equal(invalidSettingsBody.error, 'settings_invalid');
    assert.equal(invalidSettingsBody.validation.errors[0].field, 'pricing.discountPercent');
    assert.match(invalidSettingsBody.validation.errors[0].message, /0.*80/);

    const validSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        pricing: {
          discountPercent: 13,
          roundTo: 10,
          vatRate: 0.2,
          offerFactor: 0.87,
          inventoryFallbackMarkupPercent: 18
        }
      })
    });
    assert.equal(validSettings.status, 200);
    const validSettingsBody = await validSettings.json();
    assert.equal(validSettingsBody.pricing.discountPercent, 13);
    assert.equal(validSettingsBody.pricing.roundTo, 10);
    assert.equal(validSettingsBody.pricing.vatRate, 0.2);
    assert.equal(validSettingsBody.pricing.offerFactor, 0.87);
    assert.equal(validSettingsBody.pricing.inventoryFallbackMarkupPercent, 18);

    const setup = await fetch(`${baseUrl}/api/setup-status`, {
      headers: { Cookie: cookie }
    });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.equal(setupBody.process.length, 5);
    assert.match(setupBody.forwarding.query, /subject:Eduard/);

    const mailStatus = await fetch(`${baseUrl}/api/mail/status`, {
      headers: { Cookie: cookie }
    });
    assert.equal(mailStatus.status, 200);
    const mailStatusBody = await mailStatus.json();
    assert.equal(typeof mailStatusBody.gmail.configured, 'boolean');
    assert.equal(typeof mailStatusBody.outlook.configured, 'boolean');

    const gmailProofAnalysis = await fetch(`${baseUrl}/api/gmail/proof-analysis?limit=1`, {
      headers: { Cookie: cookie }
    });
    assert.equal(gmailProofAnalysis.status, 200);
    const gmailProofAnalysisBody = await gmailProofAnalysis.json();
    assert.equal(gmailProofAnalysisBody.messageCount, 1);
    assert.equal(gmailProofAnalysisBody.productsByCategory.anhaenger[0].name, 'Hochlader 3318 3500kg');

    const sampleCsv = await fetch(`${baseUrl}/api/sample-csv`, {
      headers: { Cookie: cookie }
    });
    assert.equal(sampleCsv.status, 200);
    assert.match(await sampleCsv.text(), /Art.-Nr.;Art.-Bez./);

    const invalidUpload = await fetch(`${baseUrl}/api/upload/lager`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie },
      body: 'Art.-Bez.;Lagermenge;Lagerwert\nHochlader;1;3000'
    });
    assert.equal(invalidUpload.status, 400);
    assert.equal((await invalidUpload.json()).error, 'csv_invalid');

    const validUpload = await fetch(`${baseUrl}/api/upload/lager`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie },
      body: [
        'Lager;Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert;Länge;Breite;hzGGew',
        '1;3318-4-P3-3563;Hochlader 330x180x30 3500kg;1;3000;3300;1800;3500'
      ].join('\n')
    });
    assert.equal(validUpload.status, 200);
    const validUploadBody = await validUpload.json();
    assert.equal(validUploadBody.validation.ok, true);

    const cp1252Csv = [
      'Lager;Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert;Länge;Breite;hzGGew',
      '1;3318-4-P3-3563;Rückwärtskipper Größe Zubehör;1;3000;3300;1800;3500'
    ].join('\n');
    const cp1252Upload = await fetch(`${baseUrl}/api/upload/lager`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', Cookie: cookie },
      body: Buffer.from(cp1252Csv, 'latin1')
    });
    assert.equal(cp1252Upload.status, 200);
    const cp1252UploadBody = await cp1252Upload.json();
    assert.equal(cp1252UploadBody.validation.ok, true);
    assert.equal(cp1252UploadBody.validation.stats.mappedHeaders.length, 'Länge');

    const inboundPayload = {
      provider: 'gmail',
      provider_message_id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      idempotency_key: `admin-api-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      subject: 'Eduard Anfrage',
      from_email: 'kunde@testkunde.at',
      received_at: new Date().toISOString(),
      raw_html: `
        <table>
          <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
          <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
          <tr><td><strong>E-mail-Adresse</strong></td><td>max@testkunde.at</td></tr>
          <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        </table>`
    };
    const inbound = await fetch(`${baseUrl}/api/inbound/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(inboundPayload)
    });
    assert.equal(inbound.status, 201);
    const inboundBody = await inbound.json();
    assert.ok(inboundBody.offer_run_id);

    const duplicate = await fetch(`${baseUrl}/api/inbound/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(inboundPayload)
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).duplicate, true);

    const processed = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/process`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(processed.status, 200);
    const processedBody = await processed.json();
    assert.match(processedBody.status, /completed|needs_review|failed_retryable/);
    assert.ok(processedBody.events.length >= 3);
    assert.ok(processedBody.customer_json);
    assert.ok(Array.isArray(processedBody.line_items_json));
    assert.ok(processedBody.pricing_json);
    assert.ok(processedBody.match_json);
    assert.ok(processedBody.draft_html);
    assert.ok(processedBody.draft_subject);

    const inboundStatus = await fetch(`${baseUrl}/api/inbound-status?limit=25`, {
      headers: { Cookie: cookie }
    });
    assert.equal(inboundStatus.status, 200);
    const inboundStatusBody = await inboundStatus.json();
    assert.equal(inboundStatusBody.limit, 25);
    const inboundStatusItem = inboundStatusBody.items.find((item) => item.runId === inboundBody.offer_run_id);
    assert.ok(inboundStatusItem);
    assert.equal(inboundStatusItem.provider, 'gmail');
    assert.equal(inboundStatusItem.subject, 'Eduard Anfrage');
    assert.equal(inboundStatusItem.from, 'kunde@testkunde.at');
    assert.equal(inboundStatusItem.status, processedBody.status);
    assert.equal(inboundStatusItem.error_code, processedBody.error_code || null);
    assert.equal(inboundStatusItem.error_message, processedBody.error_message || null);
    assert.ok(inboundStatusItem.lastEvent);
    assert.ok(['run_completed', 'run_needs_review', 'processing_failed', 'inventory_stale', 'price_needs_review'].includes(inboundStatusItem.lastEvent.event_type));
    assert.ok(inboundStatusItem.events.some((event) => event.event_type === 'email_received'));

    const runs = await fetch(`${baseUrl}/api/runs`, {
      headers: { Cookie: cookie }
    });
    assert.equal(runs.status, 200);
    assert.ok((await runs.json()).some((run) => run.id === inboundBody.offer_run_id));

    const reviewQueue = await fetch(`${baseUrl}/api/review-queue`, {
      headers: { Cookie: cookie }
    });
    assert.equal(reviewQueue.status, 200);
    const reviewQueueBody = await reviewQueue.json();
    assert.equal(Array.isArray(reviewQueueBody.items), true);
    if (['completed', 'sent_to_owner', 'needs_review'].includes(processedBody.status) && processedBody.draft_html) {
      assert.ok(reviewQueueBody.items.some((item) => item.id === inboundBody.offer_run_id));
    }

    const digest = await fetch(`${baseUrl}/api/review-queue/digest?dryRun=1`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(digest.status, 200);
    const digestBody = await digest.json();
    assert.equal(digestBody.dryRun, true);
    assert.equal(typeof digestBody.html, 'string');
    assert.match(digestBody.html, /Eduard Review Queue/);

    const feedback = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ rating: 'sendable', notes: 'Proof ok' })
    });
    assert.equal(feedback.status, 200);
    const feedbackBody = await feedback.json();
    assert.equal(feedbackBody.owner_feedback.rating, 'sendable');
    assert.equal(feedbackBody.owner_feedback.notes, 'Proof ok');
    assert.equal(feedbackBody.events.some((event) => event.event_type === 'owner_feedback_recorded'), true);

    const reviewQueueAfterFeedback = await fetch(`${baseUrl}/api/review-queue`, {
      headers: { Cookie: cookie }
    });
    assert.equal(reviewQueueAfterFeedback.status, 200);
    const reviewQueueAfterFeedbackBody = await reviewQueueAfterFeedback.json();
    assert.equal(reviewQueueAfterFeedbackBody.items.some((item) => item.id === inboundBody.offer_run_id), false);

    const badFeedback = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ rating: 'looks_good_but_undefined' })
    });
    assert.equal(badFeedback.status, 400);

    const feedbackToken = createFeedbackToken({
      tenantId: 'daltec-local',
      runId: inboundBody.offer_run_id,
      rating: 'minor_correction'
    }, sessionSecret);
    const publicFeedback = await fetch(`${baseUrl}/feedback?token=${encodeURIComponent(feedbackToken)}`);
    assert.equal(publicFeedback.status, 200);
    assert.match(await publicFeedback.text(), /Feedback gespeichert/);
    const feedbackDetail = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}`, {
      headers: { Cookie: cookie }
    });
    assert.equal((await feedbackDetail.json()).owner_feedback.rating, 'minor_correction');

    const invalidPublicFeedback = await fetch(`${baseUrl}/feedback?token=bad`);
    assert.equal(invalidPublicFeedback.status, 400);

    const monitoring = await fetch(`${baseUrl}/api/monitoring`, {
      headers: { Cookie: cookie }
    });
    assert.equal(monitoring.status, 200);
    const monitoringBody = await monitoring.json();
    assert.equal(typeof monitoringBody.metrics.runCount, 'number');
    assert.equal(typeof monitoringBody.metrics.excludedRunCount, 'number');
    assert.equal(typeof monitoringBody.metrics.failedRate, 'number');
    assert.equal(typeof monitoringBody.metrics.suspectedDuplicateRunCount, 'number');
    assert.equal(Array.isArray(monitoringBody.metrics.suspectedDuplicateGroups), true);
    assert.equal(Array.isArray(monitoringBody.alerts), true);
    assert.ok('inventory' in monitoringBody.metrics);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const publicInbound = await fetch(`${baseUrl}/api/eduard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-ingest-secret' },
      body: JSON.stringify({
        dealerSlug: 'daltec',
        provider: 'manual_test',
        providerMessageId: `public-${Date.now()}`,
        subject: 'Eduard Anfrage Test',
        fromEmail: 'kunde@example.com',
        toEmail: 'ventocamp@gmail.com',
        receivedAt: new Date().toISOString(),
        rawHtml: `
          <table>
            <tr><td><strong>Vorname</strong></td><td>Max</td></tr>
            <tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>
            <tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>
            <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
          </table>`,
        rawText: ''
      })
    });
    assert.match(String(publicInbound.status), /201|202/);
    const publicInboundBody = await publicInbound.json();
    assert.ok(publicInboundBody.runId);
    assert.ok(publicInboundBody.status);

    const internalOwnerDraft = await fetch(`${baseUrl}/api/eduard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-ingest-secret' },
      body: JSON.stringify({
        dealerSlug: 'daltec',
        provider: 'manual_test',
        providerMessageId: `internal-${Date.now()}`,
        subject: 'Fwd: Daltec Eduard Angebot',
        fromEmail: 'Luca Schneider <ventocamp@gmail.com>',
        toEmail: 'michael@daltec.at',
        receivedAt: new Date().toISOString(),
        rawText: 'Sehr geehrter Herr Test, vielen Dank für Ihre Anfrage zu einem Eduard Anhänger.'
      })
    });
    assert.equal(internalOwnerDraft.status, 200);
    const internalOwnerDraftBody = await internalOwnerDraft.json();
    assert.equal(internalOwnerDraftBody.status, 'ignored');
    assert.equal(internalOwnerDraftBody.errorCode, 'ignored_internal_owner_draft');

    const blockedPublicInbound = await fetch(`${baseUrl}/api/eduard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'wrong' },
      body: JSON.stringify({ providerMessageId: 'blocked' })
    });
    assert.equal(blockedPublicInbound.status, 401);
  } finally {
    if (previousIngestSecret === undefined) delete process.env.EDUARD_INGEST_SECRET;
    else process.env.EDUARD_INGEST_SECRET = previousIngestSecret;
    await new Promise((resolve) => server.close(resolve));
  }
});

it("should seed editable offer from tenant mail defaults and maintain snapshot stability", async () => {
  const tenantId = `seed-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseDir = path.join('data', 'tenants', tenantId);
  const context = {
    tenantId,
    baseDir,
    settingsPath: path.join(baseDir, 'settings.json'),
    tenantPath: path.join(baseDir, 'tenant.json'),
    offersPath: path.join(baseDir, 'offers.jsonl'),
    inventoryPath: path.join(baseDir, 'lager.csv'),
    mailConnectionsPath: path.join(baseDir, 'mail-connections.json')
  };

  try {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(context.inventoryPath, [
      'Lager;Art.-Nr.;Art.-Bez.;Lagermenge;Lagerwert;Länge;Breite;hzGGew',
      '1;3318-4-P3-3563;Hochlader 330x180x30 3500kg;1;3000;3300;1800;3500'
    ].join('\n'), 'utf8');
    await saveSettings({
      mail_defaults: {
        introTemplate: 'DALTEC-GOLD-INTRO',
        defaultNotes: 'DALTEC-GOLD-NOTES',
        signature: 'DALTEC-GOLD-SIGNATURE',
        showInventoryAlternativeDefault: false
      }
    }, context);

    const inbound = await ingestInboundMessage({
      provider: 'gmail',
      provider_message_id: `seed-proof-${tenantId}`,
      subject: 'Eduard Anfrage',
      from_email: 'kunde-seed-proof@example.at',
      received_at: new Date().toISOString(),
      raw_html: `
        <table>
          <tr><td><strong>Vorname</strong></td><td>Eva</td></tr>
          <tr><td><strong>Nachname</strong></td><td>Seedproof</td></tr>
          <tr><td><strong>E-mail-Adresse</strong></td><td>seedproof@example.at</td></tr>
          <tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>
        </table>`
    }, context);

    const processed = await processOfferRun(inbound.run.id, context);
    assert.notEqual(processed.status, 'failed_retryable');

    const seededRun = await loadOfferRun(inbound.run.id, context);
    assert.equal(seededRun.summary.editable_offer.intro, 'DALTEC-GOLD-INTRO');
    assert.equal(seededRun.summary.editable_offer.notes, 'DALTEC-GOLD-NOTES');
    assert.equal(seededRun.summary.editable_offer.signature, 'DALTEC-GOLD-SIGNATURE');
    assert.equal(seededRun.summary.editable_offer.inventory_alternative.enabled, false);
    assert.equal(seededRun.summary.editable_offer_version, 1);

    await saveSettings({
      mail_defaults: {
        introTemplate: 'NEUER-TEXT',
        defaultNotes: 'NEUE-NOTES',
        signature: 'NEUE-SIGNATURE',
        showInventoryAlternativeDefault: true
      }
    }, context);
    const changedSettings = await loadSettings(context);
    assert.equal(changedSettings.mail_defaults.introTemplate, 'NEUER-TEXT');

    const stableRun = await loadOfferRun(inbound.run.id, context);
    assert.equal(stableRun.summary.editable_offer.intro, 'DALTEC-GOLD-INTRO');
    assert.equal(stableRun.summary.editable_offer.notes, 'DALTEC-GOLD-NOTES');
    assert.equal(stableRun.summary.editable_offer.signature, 'DALTEC-GOLD-SIGNATURE');
    assert.equal(stableRun.summary.editable_offer.inventory_alternative.enabled, false);
    assert.equal(stableRun.summary.editable_offer_version, 1);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
