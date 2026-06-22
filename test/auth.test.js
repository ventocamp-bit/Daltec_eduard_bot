import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
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
    rows: [
      { product: 'Geänderter Hochlader', uvp: '€ 3.600,00', discount: '€ 410,00', offer: '€ 3.190,00' },
      { product: 'Gesamt netto', uvp: '€ 3.000,00', discount: '€ 341,67', offer: '€ 2.658,33', type: 'total' },
      { product: 'Gesamt brutto', uvp: '€ 3.600,00', discount: '€ 410,00', offer: '€ 3.190,00', type: 'gross' }
    ],
    notes: 'Bearbeiteter Hinweis',
    signature: 'Beste Grüße\nLukas'
  });

  assert.match(html, /Geänderter Hochlader/);
  assert.match(html, /€ 3\.190,00/);
  assert.match(html, /background:#FFC000;font-weight:bold;color:#000/);
  assert.match(html, /color:#c00000;font-weight:bold/);
  assert.match(html, /background:#f9f9f9/);
  assert.match(html, /border:1px solid #000/);
  assert.match(html, /font-family:Arial,sans-serif;font-size:14px/);
  assert.match(html, /Bearbeiteter Hinweis/);
});

test('review UI source contains prefilled fields spinner and success state hooks', async () => {
  const appSource = await fs.readFile(path.join('src', 'admin', 'public', 'app.js'), 'utf8');
  assert.match(appSource, /data-draft-field="to" type="email" value="\$\{escapeHtml\(draft\.to\)\}"/);
  assert.match(appSource, /data-draft-field="subject" type="text" value="\$\{escapeHtml\(draft\.subject\)\}"/);
  assert.match(appSource, /data-price-field="offer" type="text" value="\$\{escapeHtml\(row\.offer\)\}"/);
  assert.match(appSource, /button\.textContent = 'Sendet\.\.\.'/);
  assert.match(appSource, /draft-message ok/);
  assert.match(appSource, /send-to-customer/);
  assert.match(appSource, /form\.addEventListener\('input', \(\) => syncDraftPreview\(form\)\)/);
  assert.match(appSource, /previewFrame\.srcdoc = buildEditedDraftPayload\(form\)\.html/);
  assert.match(appSource, /previewStateLabel\.textContent = 'Draft'/);
});

test('review send-to-customer endpoint validates sends edited draft and marks run sent', async () => {
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

    const inboundPayload = {
      provider: 'gmail',
      provider_message_id: `send-flow-${Date.now()}`,
      subject: 'Eduard Anfrage',
      from_email: 'kunde@example.at',
      received_at: new Date().toISOString(),
      raw_html: `
        <table>
          <tr><td><strong>Vorname</strong></td><td>Eva</td></tr>
          <tr><td><strong>Nachname</strong></td><td>Kunde</td></tr>
          <tr><td><strong>E-mail-Adresse</strong></td><td>eva@example.at</td></tr>
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
    assert.deepEqual(await missingHtml.json(), { ok: false, error: 'html_required' });

    const editedHtml = [
      '<div style="font-family:Arial;font-size:14px;">',
      '<p>Sehr geehrte Frau Kunde, hier ist das bearbeitete Angebot.</p>',
      '<table style="border-collapse:collapse;font-family:Arial;font-size:14px;">',
      '<tr style="background:#FFC000;font-weight:bold;color:#000;"><th style="border:1px solid #000;">Produkt</th><th style="border:1px solid #000;">UVP</th><th style="border:1px solid #000;color:#c00000;">Rabatt</th><th style="border:1px solid #000;">Angebot</th></tr>',
      '<tr><td style="border:1px solid #000;">Bearbeiteter Hochlader</td><td style="border:1px solid #000;">€ 3.600,00</td><td style="border:1px solid #000;color:#c00000;font-weight:bold;">€ 410,00</td><td style="border:1px solid #000;">€ 3.190,00</td></tr>',
      '<tr style="background:#FFC000;font-weight:bold;"><td style="border:1px solid #000;">Gesamt brutto</td><td style="border:1px solid #000;">€ 3.600,00</td><td style="border:1px solid #000;color:#c00000;">€ 410,00</td><td style="border:1px solid #000;">€ 3.190,00</td></tr>',
      '</table><p>Hinweis nach Bearbeitung.</p><p>Beste Grüße<br>Lukas Mitter</p></div>'
    ].join('');

    const send = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}/send-to-customer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        to: 'edited@example.at',
        subject: 'Bearbeitetes Eduard Angebot',
        html: editedHtml
      })
    });
    assert.equal(send.status, 200);
    const sendBody = await send.json();
    assert.equal(sendBody.ok, true);
    assert.match(sendBody.sent_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'edited@example.at');
    assert.equal(sentMails[0].subject, 'Bearbeitetes Eduard Angebot');
    assert.match(sentMails[0].html, /Bearbeiteter Hochlader/);
    assert.match(sentMails[0].html, /Hinweis nach Bearbeitung/);
    assert.match(sentMails[0].html, /Beste Grüße/);

    const detail = await fetch(`${baseUrl}/api/offer-runs/${inboundBody.offer_run_id}`, {
      headers: { Cookie: cookie }
    });
    const detailBody = await detail.json();
    assert.equal(detailBody.status, 'sent_to_customer');
    assert.equal(detailBody.events.some((event) => event.event_type === 'sent_to_customer'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin API requires login session', async () => {
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
      provider_message_id: `msg-${Date.now()}`,
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
    assert.equal((await duplicate.json()).offer_run_id, inboundBody.offer_run_id);

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
