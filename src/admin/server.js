import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadSettings, saveSettings } from '../settings.js';
import { loadConfig } from '../config.js';
import {
  completeGoogleConnect,
  completeMicrosoftConnect,
  createGoogleConnectUrl,
  createMicrosoftConnectUrl,
  getMailConnectionStatus
} from '../mail-connections.js';
import { isEduardInquiry } from '../workflow.js';
import { processOfferRun, recordOwnerFeedback, setOfferRunStatus } from '../offer-run-service.js';
import { deliverRunDraftToOwner } from '../owner-delivery.js';
import { createMailRuntime } from '../mail-runtime.js';
import { atomicWriteFile, decodeCsvBuffer, fileExists, fileMetadata, readCsvObjects } from '../adapters/local-data.js';
import { validateInventoryCsv } from '../core/csv-validator.js';
import { resolveTenantContextForInbound } from '../dealer-routing.js';
import { isInternalOwnerDraft } from '../internal-mail.js';
import { createFeedbackToken, verifyFeedbackToken } from '../feedback-token.js';
import { buildRuntimeReadiness } from '../production-readiness.js';
import { exportGmailMessages } from '../export-mails.js';
import { extractInquiry } from '../core/parser.js';
import { resolveProductCategory } from '../core/pricing.js';
import { createImapPollerRegistry, resolveImapHost, testImapConnection } from '../core/imap-poller.js';
import {
  INVENTORY_ALTERNATIVE_RULES,
  buildEditableOfferState,
  checkEditableOfferConsistency,
  normalizeEditableOffer,
  renderEditableOfferHtml
} from '../core/editable-offer.js';
import { listInventoryImports } from '../inventory-import.js';
import { processMailMessage } from '../index.js';
import {
  buildReviewQueue as buildSharedReviewQueue,
  sendReviewQueueDigest as sendSharedReviewQueueDigest
} from '../review-digest.js';
import {
  appendOfferRunEvent,
  claimOfferRunForCustomerSend,
  ingestInboundMessage,
  listOfferRecords,
  listOfferRuns,
  loadOfferRun,
  loadTenant,
  saveTenant,
  updateOfferRun,
  getOnboardingChecklist
} from '../storage.js';
import { tenantContext } from '../tenant-context.js';
import {
  authConfig,
  clearSessionCookie,
  createSession,
  destroySession,
  getSession,
  parseCookies,
  sessionCookie,
  verifyPassword
} from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
const port = Number(process.env.ADMIN_PORT || 3030);

export function getProofTargetRuns(env = process.env) {
  const parsed = Number.parseInt(env.PROOF_TARGET_RUNS || '100', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export function tenantIdFromHost(hostHeader = '', env = process.env) {
  const host = String(hostHeader || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  const mappings = hostTenantMappings(env);
  if (host && mappings[host]) return mappings[host];
  if (host.includes('haemmerle') || host.includes('hammerle')) return 'haemmerle-local';
  return 'daltec-local';
}

function hostTenantMappings(env = process.env) {
  const raw = String(env.TENANT_HOST_MAP || '');
  return Object.fromEntries(raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, tenantId] = entry.split('=').map((part) => String(part || '').trim().toLowerCase());
      return [host, tenantId];
    })
    .filter(([host, tenantId]) => host && tenantId));
}

function requestTenantId(req, auth) {
  return tenantIdFromHost(req.headers['x-forwarded-host'] || req.headers.host, process.env) || auth.tenantId || 'daltec-local';
}

export function createAdminApp(options = {}) {
  const app = express();
  const auth = options.auth || authConfig();
  const gmailProofAnalyzer = options.gmailProofAnalyzer || buildGmailProofAnalysis;
  const microsoftOAuth = options.microsoftOAuth || {};
  const imap = options.imap || createDefaultImapRegistry();
  const mailRuntimeFactory = options.mailRuntimeFactory || ((config, context) => createMailRuntime(config, context));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (email !== auth.email || !verifyPassword(password, auth.secret)) {
      res.status(401).json({ error: 'Login fehlgeschlagen' });
      return;
    }

    const tenantAuth = { ...auth, tenantId: requestTenantId(req, auth) };
    const { token, session } = createSession(email, tenantAuth);
    res.setHeader('Set-Cookie', sessionCookie(token, tenantAuth));
    res.json({ email: session.email, expiresAt: session.expiresAt });
  });

  app.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (email !== auth.email || !verifyPassword(password, auth.secret)) {
      res.redirect('/?login=failed');
      return;
    }

    const tenantAuth = { ...auth, tenantId: requestTenantId(req, auth) };
    const { token } = createSession(email, tenantAuth);
    res.setHeader('Set-Cookie', sessionCookie(token, tenantAuth));
    res.redirect('/');
  });

  app.get('/login/local', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).send('Not found');
      return;
    }

    const tenantAuth = { ...auth, tenantId: requestTenantId(req, auth) };
    const { token } = createSession(auth.email, tenantAuth);
    res.setHeader('Set-Cookie', sessionCookie(token, tenantAuth));
    res.redirect('/');
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[auth.cookieName];
    destroySession(token);
    res.setHeader('Set-Cookie', clearSessionCookie(auth));
    res.json({ ok: true });
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/feedback', async (req, res, next) => {
  try {
    const payload = verifyFeedbackToken(req.query.token, auth.sessionSecret);
    await recordOwnerFeedback(payload.runId, { rating: payload.rating }, tenantContext({ tenantId: payload.tenantId }));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Feedback gespeichert</title><style>body{font-family:Arial,sans-serif;background:#f3f4f6;margin:0;display:grid;place-items:center;min-height:100vh;color:#111827}.box{background:#fff;border:1px solid #e1e5eb;border-radius:8px;padding:24px;max-width:460px}strong{display:block;font-size:20px;margin-bottom:8px}</style></head><body><div class="box"><strong>Feedback gespeichert</strong><p>Danke. Die Bewertung wurde im Flight Recorder gespeichert.</p><p>Sie können dieses Fenster schließen.</p></div></body></html>`);
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/eduard/inbound', async (req, res, next) => {
  try {
    authorizeIngest(req);
    const payload = normalizeEduardInboundPayload(req.body || {});
    const inboundContext = await resolveTenantContextForInbound(payload);
    const settings = await loadSettings(inboundContext);
    const config = loadConfig();
    const configSnapshot = {
      dealerId: inboundContext.tenantId,
      dealerSlug: payload.dealerSlug,
      settings,
      capturedAt: new Date().toISOString()
    };

    const inbound = await ingestInboundMessage({
      provider: payload.provider,
      provider_message_id: payload.providerMessageId,
      subject: payload.subject,
      from_email: payload.fromEmail,
      to_email: payload.toEmail,
      received_at: payload.receivedAt,
      raw_html: payload.rawHtml,
      raw_text: payload.rawText,
      idempotency_key: payload.idempotencyKey
    }, inboundContext);

    if (inbound.run) {
      await updateOfferRun(inbound.run.id, {
        raw_input: {
          subject: payload.subject,
          fromEmail: payload.fromEmail,
          toEmail: payload.toEmail,
          receivedAt: payload.receivedAt,
          rawHtml: payload.rawHtml,
          rawText: payload.rawText
        },
        config_snapshot: configSnapshot
      }, inboundContext);
    }

    if (inbound.duplicate) {
      const existingRun = inbound.run ? await loadOfferRun(inbound.run.id, inboundContext) : null;
      res.status(200).json(formatInboundResult(existingRun, true, settings));
      return;
    }

    if (isInternalOwnerDraft({
      subject: payload.subject,
      fromEmail: payload.fromEmail
    }, config, settings)) {
      await updateOfferRun(inbound.run.id, {
        status: 'ignored',
        completed_at: new Date().toISOString(),
        error_code: 'ignored_internal_owner_draft',
        error_message: 'Interne Angebotsmail wurde ignoriert.'
      }, inboundContext);
      await appendOfferRunEvent(inbound.run.id, {
        event_type: 'ignored_internal_owner_draft',
        level: 'info',
        message: 'Internal owner draft ignored before processing',
        metadata: { subject: payload.subject, fromEmail: payload.fromEmail }
      }, inboundContext);
      res.status(200).json(formatInboundResult(await loadOfferRun(inbound.run.id, inboundContext), false, settings));
      return;
    }

    if (!isEduardInquiry({ subject: payload.subject }, config.gmail.subjectFilter)) {
      await updateOfferRun(inbound.run.id, {
        status: 'ignored',
        completed_at: new Date().toISOString(),
        error_code: 'ignored_not_eduard',
        error_message: 'Betreff passt nicht zum Eduard-Filter.'
      }, inboundContext);
      await appendOfferRunEvent(inbound.run.id, {
        event_type: 'ignored_not_eduard',
        level: 'info',
        message: 'Message ignored because subject did not match Eduard filter',
        metadata: { subject: payload.subject }
      }, inboundContext);
      res.status(200).json(formatInboundResult(await loadOfferRun(inbound.run.id, inboundContext), false, settings));
      return;
    }

    let processed = await processOfferRun(inbound.run.id, inboundContext);
    let delivery = { delivered: false, reason: 'not_attempted' };
    if (['completed', 'needs_review'].includes(processed.status) && processed.draft) {
      try {
        delivery = await deliverRunDraftToOwner(processed, settings, inboundContext);
        processed = await loadOfferRun(inbound.run.id, inboundContext);
      } catch (deliveryError) {
        delivery = { delivered: false, reason: deliveryError.message };
        await appendOfferRunEvent(inbound.run.id, {
          event_type: 'owner_delivery_failed',
          level: 'error',
          message: deliveryError.message
        }, inboundContext);
        processed = await loadOfferRun(inbound.run.id, inboundContext);
      }
    }
    const statusCode = processed.status === 'failed_retryable' || processed.status === 'failed_terminal'
      ? 500
      : processed.status === 'needs_review'
        ? 202
        : 201;
    res.status(statusCode).json({ ...formatInboundResult(processed, false, settings), delivery });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/auth/me', (req, res) => {
    const token = parseCookies(req.headers.cookie)[auth.cookieName];
    const session = getSession(token, auth);
    if (!session) {
      res.status(401).json({ error: 'Nicht angemeldet' });
      return;
    }
    res.json({ email: session.email, tenantId: requestTenantId(req, auth), expiresAt: session.expiresAt });
  });

  app.get('/api/oauth/google/callback', async (req, res, next) => {
  try {
    await completeGoogleConnect(loadConfig(), req.query.code, req.query.state, auth.sessionSecret);
    res.redirect('/onboarding?mail_connected=gmail');
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/oauth/microsoft/callback', async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie)[auth.cookieName];
    const session = getSession(token, auth);
    await completeMicrosoftConnect(loadConfig(), req.query.code, req.query.state, auth.sessionSecret, {
      ...microsoftOAuth,
      tenantId: session?.tenantId || requestTenantId(req, auth)
    });
    res.redirect('/?mail_connected=outlook');
  } catch (error) {
    next(error);
  }
  });

  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[auth.cookieName];
    const session = getSession(token, auth);
    if (!session) {
      res.status(401).json({ error: 'Nicht angemeldet' });
      return;
    }
    const tenantId = requestTenantId(req, auth);
    req.session = { ...session, tenantId };
    req.tenantContext = tenantContext({ tenantId });
    next();
  });

  app.get('/api/settings', async (req, res, next) => {
  try {
    const settings = await loadSettings(req.tenantContext);
    if (settings.mail?.internalSubject && !settings.mail.subject) {
      settings.mail.subject = settings.mail.internalSubject;
    }
    delete settings.mail?.cc;
    delete settings.mail?.internalSubject;
    res.json(settings);
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/mail/status', async (req, res, next) => {
  try {
    res.json(await getMailConnectionStatus(loadConfig(), req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/gmail/proof-analysis', async (req, res, next) => {
  try {
    res.json(await gmailProofAnalyzer({
      tenantId: req.tenantContext.tenantId,
      limit: req.query.limit,
      query: req.query.query,
      proofOnly: req.query.proofOnly !== '0',
      settings: await loadSettings(req.tenantContext)
    }));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/oauth/google/start', async (req, res, next) => {
  try {
    res.redirect(await createGoogleConnectUrl(loadConfig(), req.tenantContext, auth.sessionSecret));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/oauth/microsoft/start', async (req, res, next) => {
  try {
    res.redirect(createMicrosoftConnectUrl(loadConfig(), req.tenantContext, auth.sessionSecret));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/settings', async (req, res, next) => {
  try {
    const validation = validateSettingsPayload(req.body || {});
    if (!validation.ok) {
      res.status(400).json({
        error: 'settings_invalid',
        message: 'Einstellungen wurden nicht gespeichert, weil Preiswerte ungültig sind.',
        validation
      });
      return;
    }
    res.json(await saveSettings(req.body, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/data-status', async (req, res, next) => {
  try {
    const settings = await loadSettings(req.tenantContext);
    const latestImport = (await listInventoryImports(1, req.tenantContext))[0] || null;
    res.json({
      lagerCsvExists: await fileExists(settings.data?.lagerCsvPath || req.tenantContext.inventoryPath),
      usingLocalCsv: settings.data?.preferLocalCsv === true,
      inventoryImportEmail: settings.data?.inventoryImportEmail || settings.onboarding?.inventoryImportEmail || null,
      latestInventoryImport: latestImport
    });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/inventory-imports', async (req, res, next) => {
  try {
    res.json(await listInventoryImports(Number(req.query.limit || 20), req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/setup-status', async (req, res, next) => {
  try {
    const [settings, tenant] = await Promise.all([loadSettings(req.tenantContext), loadTenant(req.tenantContext)]);
    const config = loadConfig();
    const mailStatus = await getMailConnectionStatus(config, req.tenantContext);
    const inventoryPath = settings.data?.lagerCsvPath || req.tenantContext.inventoryPath;
    const centralInbox = settings.onboarding?.forwardingEmail || config.gmail.cc || 'ventocamp@gmail.com';
    const gmailQuery = `is:unread from:${config.gmail.senderQuery} subject:${config.gmail.subjectFilter}`;
    const checks = [
      {
        id: 'gmail-client',
        label: 'Gmail App verbunden',
        done: mailStatus.gmail.configured,
        detail: mailStatus.gmail.configured ? 'OAuth App ist zentral eingerichtet.' : 'Google OAuth Client fehlt auf Server-Seite.'
      },
      {
        id: 'gmail-token',
        label: 'Gmail Zugriff freigegeben',
        done: mailStatus.gmail.connected || mailStatus.outlook.connected,
        detail: mailStatus.gmail.connected
          ? `Gmail verbunden${mailStatus.gmail.email ? `: ${mailStatus.gmail.email}` : ''}`
          : mailStatus.outlook.connected
            ? `Outlook verbunden${mailStatus.outlook.email ? `: ${mailStatus.outlook.email}` : ''}`
            : 'Gmail oder Outlook noch nicht verbunden.'
      },
      {
        id: 'inventory',
        label: 'Lager-/Preis-CSV geladen',
        done: await fileExists(inventoryPath),
        detail: 'Eine CSV für Lager, Preise und Upsell.'
      },
      {
        id: 'mail-target',
        label: 'Interne Zustellung gesetzt',
        done: Boolean(settings.mail?.to || config.gmail.to),
        detail: settings.mail?.to || config.gmail.to
      }
    ];

    res.json({
      company: tenant.name || 'Daltec',
      ready: checks.every((check) => check.done),
      checks,
      process: [
        {
          step: '1',
          title: 'Requirements prüfen',
          text: 'Nur Eduard-Anfragen, Mail-Eingang, interne Zieladresse und Lagerdaten sind Pflicht.'
        },
        {
          step: '2',
          title: 'Überflüssiges löschen',
          text: 'Keine Sheet-IDs, keine extra Preisliste, kein sichtbares CC, keine manuelle Kundenmail.'
        },
        {
          step: '3',
          title: 'Vereinfachen',
          text: 'Eine CSV, eine Vorschau, ein internes Angebot.'
        },
        {
          step: '4',
          title: 'Beschleunigen',
          text: 'CSV hochladen, Vorschau prüfen, Polling starten.'
        },
        {
          step: '5',
          title: 'Automatisieren',
          text: 'Gmail oder Outlook pollt alle 5 Minuten und sendet den Vorschlag intern.'
        }
      ],
      forwarding: {
        label: 'Weiterleitung',
        centralInbox,
        query: gmailQuery,
        action: `Eduard-Anfragen automatisch an ${centralInbox} weiterleiten. Kein Google-Login beim Händler nötig.`
      },
      nextCommands: ['npm run admin', 'npm run poll'],
      sampleCsvUrl: '/api/sample-csv'
    });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/monitoring', async (req, res, next) => {
  try {
    res.json(await buildMonitoringSnapshot(req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/saas-readiness', async (req, res, next) => {
  try {
    res.json(await buildSaasReadinessSnapshot(req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/sample-csv', async (req, res, next) => {
  try {
    const samplePath = path.resolve('data/lager-preis-muster.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lager-preis-muster.csv"');
    res.send(await fs.readFile(samplePath, 'utf8'));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/onboarding', async (req, res, next) => {
  try {
    const [settings, tenant] = await Promise.all([loadSettings(req.tenantContext), loadTenant(req.tenantContext)]);
    const dataStatus = {
      lagerCsvExists: await fileExists(settings.data?.lagerCsvPath || req.tenantContext.inventoryPath)
    };
    res.json({
      tenant,
      checklist: getOnboardingChecklist(tenant, settings, dataStatus)
    });
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/tenant', async (req, res, next) => {
  try {
    res.json(await saveTenant(req.body, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/tenant/:tenantId/imap/connect', async (req, res, next) => {
  let imapSettings;
  try {
    ensureTenantParam(req);
    imapSettings = normalizeImapPayload(req.body || {});
    await (imap.testConnection || testImapConnection)(imapSettings);
    const settings = await loadSettings(req.tenantContext);
    await saveSettings({ ...settings, imap: imapSettings }, req.tenantContext);
    await imap.startTenant?.(req.params.tenantId);
    res.json({ ok: true, active: imap.isActive ? imap.isActive(req.params.tenantId) : true });
  } catch (error) {
    if (imapSettings?.host && !String(error.message || '').includes(imapSettings.host)) {
      error.message = `${error.message} host=${imapSettings.host}`;
    }
    next(error);
  }
  });

  app.delete('/api/tenant/:tenantId/imap/disconnect', async (req, res, next) => {
  try {
    ensureTenantParam(req);
    const settings = await loadSettings(req.tenantContext);
    await saveSettings({ ...settings, imap: undefined }, req.tenantContext);
    imap.stopTenant?.(req.params.tenantId);
    res.json({ ok: true, active: false });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/offers', async (req, res, next) => {
  try {
    res.json(await listOfferRecords(25, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/runs', async (req, res, next) => {
  try {
    res.json(await listOfferRuns(25, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/inbound-status', async (req, res, next) => {
  try {
    const limit = clampNumber(req.query.limit, 1, 100, 25);
    res.json(await buildInboundStatusSnapshot(req.tenantContext, limit));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/debug/manual-ingest', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production' || req.hostname !== 'localhost') {
      res.status(403).json({ ok: false, error: 'Forbidden: Local debug only' });
      return;
    }
    const rawText = String(req.body?.rawText || '').trim();
    if (!rawText) {
      res.status(400).json({ ok: false, error: 'Missing rawText' });
      return;
    }
    const date = new Date().toISOString();
    const dummyMessage = {
      text: rawText,
      subject: req.body?.subject || 'Manuelle Anfrage',
      from: req.body?.from || 'interne-injektion@daltec.at',
      to: 'office@daltec.at',
      date,
      received_at: date
    };
    const result = await ingestInboundMessage(dummyMessage, req.tenantContext);
    res.status(200).json({
      ok: true,
      duplicate: result.duplicate,
      message_id: result.message?.id || null,
      offer_run_id: result.run?.id || null,
      status: result.run?.status || 'received'
    });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/review-queue', async (req, res, next) => {
  try {
    res.json(await buildSharedReviewQueue(req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/review-queue/digest', async (req, res, next) => {
  try {
    res.json(await sendSharedReviewQueueDigest(req.tenantContext, {
      dryRun: req.query.dryRun === '1' || req.body?.dryRun === true,
      limit: Number(req.body?.limit || req.query.limit || 20),
      auth
    }));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/inbound/email', async (req, res, next) => {
  try {
    const result = await ingestInboundMessage(req.body || {}, req.tenantContext);
    res.status(result.duplicate ? 409 : 201).json({
      duplicate: result.duplicate,
      message_id: result.message.id,
      offer_run_id: result.run?.id || null,
      status: result.duplicate ? 'duplicate_message' : result.run.status
    });
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/offer-runs/:id/process', async (req, res, next) => {
  try {
    res.json(await processOfferRun(req.params.id, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/offer-runs', async (req, res, next) => {
  try {
    const statuses = String(req.query.status || '')
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    const runs = await listOfferRuns(500, req.tenantContext);
    res.json(statuses.length ? runs.filter((run) => statuses.includes(run.status)) : runs);
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/offer-runs/:id/review-state', async (req, res, next) => {
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ ok: false, error: 'run_not_found' });
      return;
    }
    const settings = await loadSettings(req.tenantContext);
    res.json({
      ok: true,
      ...buildReviewStateForRun(run, editableOfferStateWithContentDefaults(run, {}, settings))
    });
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/offer-runs/:id', async (req, res, next) => {
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/debug/offer-runs/:id/ssot-check', async (req, res, next) => {
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ ok: false, error: 'run_not_found' });
      return;
    }
    res.json({
      ...checkEditableOfferConsistency(run),
      inventoryAlternativeRules: INVENTORY_ALTERNATIVE_RULES
    });
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/offer-runs/:id/retry', async (req, res, next) => {
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (!['failed_retryable', 'needs_review'].includes(run.status)) {
      res.status(409).json({ error: 'not_retryable' });
      return;
    }
    if (Number(run.retry_count || 0) >= 3) {
      res.status(429).json({ error: 'retry_limit_exceeded' });
      return;
    }
    await updateOfferRun(run.id, { retry_count: Number(run.retry_count || 0) + 1, status: 'received' }, req.tenantContext);
    await appendOfferRunEvent(run.id, {
      event_type: 'retry_started',
      message: req.body?.retry_reason || 'Manual retry started'
    }, req.tenantContext);
    res.json(await processOfferRun(run.id, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.patch('/api/offer-runs/:id/status', async (req, res, next) => {
  try {
    const allowed = new Set(['approved', 'sent_to_customer', 'won', 'lost', 'ignored']);
    if (!allowed.has(req.body?.status)) {
      res.status(400).json({ error: 'invalid_transition' });
      return;
    }
    res.json(await setOfferRunStatus(req.params.id, req.body.status, req.body, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/offer-runs/:id/send-to-customer', async (req, res) => {
  let claimedRun = null;
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ ok: false, error: 'run_not_found' });
      return;
    }
    if (run.summary?.needsManualCorrection === true) {
      res.status(409).json({ ok: false, error: 'manual_correction_required' });
      return;
    }
    const draft = normalizeCustomerSendPayload(req.body || {});
    const settings = await loadSettings(req.tenantContext);
    const rendered = renderEditableOfferForRun(run, draft.editable_offer, settings);
    const finalHtml = rendered.html;
    claimedRun = await claimOfferRunForCustomerSend(run.id, {
      to: draft.to,
      subject: draft.subject,
      html: finalHtml,
      editable_offer: rendered.normalized_editable_offer
    }, req.tenantContext);
    if (!claimedRun) {
      res.status(404).json({ ok: false, error: 'run_not_found' });
      return;
    }
    const config = loadConfig();
    const runtime = await mailRuntimeFactory(config, req.tenantContext);
    const cc = settings.mail?.cc || config.gmail.cc || '';
    await runtime.sendHtmlMail(runtime.client, {
      to: draft.to,
      cc,
      subject: draft.subject,
      html: finalHtml
    });
    const sentAt = new Date().toISOString();
    await updateOfferRun(run.id, {
      status: 'sent_to_customer',
      draft_subject: draft.subject,
      draft_html: finalHtml,
      completed_at: sentAt,
      summary: {
        ...(claimedRun.summary || run.summary || {}),
        customerEmail: draft.to,
        customerSentAt: sentAt,
        editable_offer: rendered.normalized_editable_offer
      }
    }, req.tenantContext);
    await appendOfferRunEvent(run.id, {
      event_type: 'sent_to_customer',
      message: `Edited draft sent to customer ${draft.to}`,
      metadata: { to: draft.to, cc, subject: draft.subject, provider: runtime.provider || 'unknown' }
    }, req.tenantContext);
    res.json({ ok: true, sent_at: sentAt });
  } catch (error) {
    if (claimedRun && error.statusCode !== 409) {
      const failedAt = new Date().toISOString();
      await updateOfferRun(claimedRun.id, {
        status: 'needs_review',
        error_code: 'customer_delivery_failed',
        error_message: error.message,
        summary: {
          ...(claimedRun.summary || {}),
          customerDeliveryFailedAt: failedAt
        }
      }, req.tenantContext).catch(() => null);
      await appendOfferRunEvent(claimedRun.id, {
        event_type: 'customer_delivery_failed',
        level: 'error',
        message: `Customer mail delivery failed: ${error.message}`,
        metadata: { error: error.message }
      }, req.tenantContext).catch(() => null);
    }
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
  });

  app.post('/api/offer-runs/:id/render-editable-offer', async (req, res) => {
    try {
      const run = await loadOfferRun(req.params.id, req.tenantContext);
      if (!run) {
        res.status(404).json({ ok: false, error: 'run_not_found' });
        return;
      }
      const settings = await loadSettings(req.tenantContext);
      const rendered = renderEditableOfferForRun(run, req.body?.editable_offer || req.body || {}, settings);
      res.json({
        ok: true,
        html: rendered.html,
        normalized_editable_offer: rendered.normalized_editable_offer,
        review_state: rendered.review_state,
        summary: rendered.summary
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: error.message });
    }
  });

  app.patch('/api/offer-runs/:id/editable-offer', async (req, res) => {
  try {
    const run = await loadOfferRun(req.params.id, req.tenantContext);
    if (!run) {
      res.status(404).json({ ok: false, error: 'run_not_found' });
      return;
    }
    if (isFinalOfferRun(run)) {
      res.status(409).json({ ok: false, error: 'run_finalized' });
      return;
    }
    const expectedVersion = Number(req.body?.version);
    const currentVersion = Number(run.summary?.editable_offer_version || 1);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion) {
      res.status(409).json({
        ok: false,
        error: 'editable_offer_conflict',
        current_version: currentVersion,
        editable_offer: run.summary?.editable_offer || null
      });
      return;
    }
    const editableOffer = buildEditableOfferState(run, {
      editable_offer: req.body?.editable_offer || req.body || {}
    }).editable_offer;
    const nextVersion = currentVersion + 1;
    const updated = await updateOfferRun(run.id, {
      summary: {
        ...(run.summary || {}),
        editable_offer: editableOffer,
        editable_offer_version: nextVersion
      }
    }, req.tenantContext);
    await appendOfferRunEvent(run.id, {
      event_type: 'editable_offer_updated',
      message: 'Editable offer settings updated',
      metadata: { editable_offer: editableOffer }
    }, req.tenantContext);
    res.json({
      ok: true,
      editable_offer: updated.summary?.editable_offer || editableOffer,
      version: updated.summary?.editable_offer_version || nextVersion
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
  });

  app.post('/api/offer-runs/:id/feedback', async (req, res, next) => {
  try {
    const updated = await recordOwnerFeedback(req.params.id, req.body || {}, req.tenantContext);
    res.json(await loadOfferRun(updated.id, req.tenantContext));
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/admin/dealers/:dealerId/runs', async (req, res, next) => {
  try {
    res.json(await listOfferRuns(100, tenantContext({ tenantId: req.params.dealerId })));
  } catch (error) {
    next(error);
  }
  });

  app.post('/api/upload/:kind', express.raw({ type: '*/*', limit: '20mb' }), async (req, res, next) => {
  try {
    const settings = await loadSettings(req.tenantContext);
    const kind = req.params.kind;
    const target = settings.data?.lagerCsvPath || req.tenantContext.inventoryPath;

    if (kind !== 'lager') {
      res.status(400).json({ error: 'kind muss lager sein' });
      return;
    }

    const csvText = decodeCsvBuffer(req.body || Buffer.alloc(0));
    const validation = validateInventoryCsv(csvText);
    if (!validation.ok) {
      res.status(400).json({
        error: 'csv_invalid',
        message: 'Lager-/Preis-CSV wurde nicht gespeichert, weil Pflichtdaten fehlen oder ungültig sind.',
        validation
      });
      return;
    }

    await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    const backupPath = await backupFileIfExists(target);
    await atomicWriteFile(target, csvText);
    await saveSettings({ ...settings, data: { ...(settings.data || {}), preferLocalCsv: true } }, req.tenantContext);
    const tenant = await loadTenant(req.tenantContext);
    await saveTenant({
      ...tenant,
      onboarding: {
        ...tenant.onboarding,
        inventoryConnected: true
      }
    }, req.tenantContext);
    res.json({ ok: true, path: target, backupPath, validation });
  } catch (error) {
    next(error);
  }
  });

  app.use((error, req, res, next) => {
    if (!error.statusCode || error.statusCode >= 500) console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message });
  });

  return app;
}

function createDefaultImapRegistry() {
  return createImapPollerRegistry({
    loadSettings,
    tenantContext: (tenantId) => tenantContext({ tenantId }),
    onMessage: async (message, context) => {
      const settings = await loadSettings(context);
      const config = loadConfig();
      const effectiveConfig = {
        ...config,
        gmail: {
          ...config.gmail,
          to: settings.mail?.to || config.gmail.to,
          cc: 'ventocamp@gmail.com',
          subject: settings.mail?.subject || settings.mail?.internalSubject || config.gmail.subject
        }
      };
      await processMailMessage(message, {
        provider: 'imap',
        client: null,
        labelMessage: async () => null,
        markMessageRead: async () => null,
        sendHtmlMail: async () => {
          const error = new Error('imap_send_not_supported');
          error.statusCode = 400;
          throw error;
        }
      }, effectiveConfig, settings, { forcedTenantContext: context });
    }
  });
}

function ensureTenantParam(req) {
  if (req.params.tenantId === req.tenantContext.tenantId) return;
  const error = new Error('tenant_forbidden');
  error.statusCode = 403;
  throw error;
}

function normalizeImapPayload(input = {}) {
  const email = String(input.email || '').trim();
  const appPassword = String(input.app_password || '').trim();
  if (!email || !appPassword) {
    const error = new Error('imap_credentials_required');
    error.statusCode = 400;
    throw error;
  }
  return {
    email,
    app_password: appPassword,
    host: resolveImapHost({ email, host: input.host }),
    ...(input.port ? { port: Number(input.port) } : {}),
    ...(typeof input.tls === 'boolean' ? { tls: input.tls } : {})
  };
}

function authorizeIngest(req) {
  const expected = process.env.EDUARD_INGEST_SECRET;
  if (!expected) {
    const error = new Error('EDUARD_INGEST_SECRET_missing');
    error.statusCode = 500;
    throw error;
  }
  if (req.headers['x-ingest-secret'] !== expected) {
    const error = new Error('unauthorized_inbound_request');
    error.statusCode = 401;
    throw error;
  }
}

function validateSettingsPayload(payload = {}) {
  const pricing = payload.pricing || {};
  const errors = [];
  checkRange(errors, pricing, 'discountPercent', 0, 80, 'Basis-Rabatt % muss zwischen 0 und 80 liegen.');
  checkWhitelist(errors, pricing, 'roundTo', [1, 5, 10, 50, 100], 'Rundung auf muss 1, 5, 10, 50 oder 100 sein.');
  checkRange(errors, pricing, 'vatRate', 0, 0.5, 'MwSt. muss zwischen 0.0 und 0.5 liegen.');
  checkRange(errors, pricing, 'offerFactor', 0.5, 1.0, 'Offer-Faktor muss zwischen 0.5 und 1.0 liegen.');
  checkRange(errors, pricing, 'inventoryFallbackMarkupPercent', 0, 200, 'EK-Aufschlag Lager % muss zwischen 0 und 200 liegen.');
  return { ok: errors.length === 0, errors };
}

function checkRange(errors, object, key, min, max, message) {
  if (object[key] === undefined || object[key] === '') return;
  const value = Number(object[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push({ field: `pricing.${key}`, code: 'out_of_range', message, min, max, value: object[key] });
  }
}

function checkWhitelist(errors, object, key, allowed, message) {
  if (object[key] === undefined || object[key] === '') return;
  const value = Number(object[key]);
  if (!Number.isFinite(value) || !allowed.includes(value)) {
    errors.push({ field: `pricing.${key}`, code: 'not_allowed', message, allowed, value: object[key] });
  }
}

function normalizeEduardInboundPayload(input) {
  const providerMessageId = input.providerMessageId || input.provider_message_id || input.id || '';
  if (!providerMessageId) {
    const error = new Error('providerMessageId_required');
    error.statusCode = 400;
    throw error;
  }
  return {
    dealerSlug: input.dealerSlug || input.dealer_slug || '',
    provider: input.provider || 'api',
    providerMessageId,
    idempotencyKey: input.idempotencyKey || input.idempotency_key || '',
    subject: input.subject || input.Subject || '',
    fromEmail: input.fromEmail || input.from_email || input.from || '',
    toEmail: input.toEmail || input.to_email || input.to || '',
    receivedAt: input.receivedAt || input.received_at || new Date().toISOString(),
    rawHtml: input.rawHtml || input.raw_html || input.html || '',
    rawText: input.rawText || input.raw_text || input.text || ''
  };
}

function formatInboundResult(run, duplicate, settings) {
  if (!run) {
    return {
      duplicate,
      runId: null,
      status: 'received',
      draft: null,
      errorCode: null,
      errorMessage: null
    };
  }
  return {
    duplicate,
    runId: run.id,
    status: run.status,
    draft: run.draft || run.draft_html ? {
      subject: run.draft?.subject || run.draft_subject || '',
      html: run.draft?.html_body || run.draft_html || '',
      ownerEmail: settings.mail?.to || '',
      ccEmail: null,
      replyToEmail: settings.signature?.email || null
    } : null,
    errorCode: run.error_code || null,
    errorMessage: run.error_message || null,
    summary: run.summary || {},
    events: run.events || []
  };
}

async function backupFileIfExists(filePath) {
  if (!(await fileExists(filePath))) return null;
  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(parsed.dir, 'backups');
  const backupPath = path.join(backupDir, `${parsed.name}.${stamp}${parsed.ext}.bak`);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function buildMonitoringSnapshot(context) {
  const config = loadConfig();
  const [settings, mailStatus, runs] = await Promise.all([
    loadSettings(context),
    getMailConnectionStatus(config, context),
    listOfferRuns(500, context)
  ]);
  const details = await Promise.all(runs.map((run) => loadOfferRun(run.id, context)));
  const now = Date.now();
  const windowHours = 24;
  const cutoff = now - windowHours * 36e5;
  const recentAll = details.filter((run) => new Date(run?.created_at || 0).getTime() >= cutoff);
  const excluded = recentAll.filter((run) => isMonitoringNoise(run, config, settings));
  const recent = recentAll.filter((run) => !isMonitoringNoise(run, config, settings));
  const processed = recent.filter((run) => !['received', 'parsing', 'parsed', 'matching', 'pricing', 'drafting'].includes(run.status));
  const failed = recent.filter((run) => String(run.status || '').startsWith('failed'));
  const needsReview = recent.filter((run) => run.status === 'needs_review');
  const reviewRisk = recent.filter(hasReviewRisk);
  const sentToOwner = recent.filter((run) => run.status === 'sent_to_owner');
  const completed = recent.filter((run) => run.status === 'completed');
  const duplicateEvents = recent.flatMap((run) => run.events || []).filter((event) => event.event_type === 'email_deduplicated');
  const suspectedDuplicateGroups = findSuspectedDuplicateGroups(recent);
  const suspectedDuplicateRunCount = suspectedDuplicateGroups.reduce((sum, group) => sum + group.extraRuns, 0);
  const ownerMailFailures = recent.flatMap((run) => run.events || []).filter((event) => event.event_type === 'owner_delivery_failed');
  const inventoryStaleRuns = recent.filter((run) =>
    run.error_code === 'inventory_stale' ||
    (run.events || []).some((event) => event.event_type === 'inventory_stale')
  );
  const feedback = recent.map((run) => run.owner_feedback || run.summary?.ownerFeedback).filter(Boolean);
  const sendableFeedback = feedback.filter((item) => ['sendable', 'minor_correction'].includes(item.rating));
  const inventoryPath = settings.data?.lagerCsvPath || context.inventoryPath;
  const inventoryMeta = await fileMetadata(inventoryPath);
  const inventoryMaxAgeHours = Number(settings.data?.inventoryMaxAgeHours ?? 24);
  const inventoryAgeHours = inventoryMeta.modifiedAt ? (now - new Date(inventoryMeta.modifiedAt).getTime()) / 36e5 : Infinity;
  const inventoryIsStale = !inventoryMeta.exists || inventoryAgeHours > inventoryMaxAgeHours;
  const inventoryItemCount = await countInventoryItems(inventoryPath);
  const minInventoryItems = Number(settings.data?.minInventoryItems ?? 15);
  const mailConnected = mailStatus.gmail.connected || mailStatus.outlook.connected;
  const metrics = {
    windowHours,
    runCount: recent.length,
    excludedRunCount: excluded.length,
    processedCount: processed.length,
    completedCount: completed.length,
    sentToOwnerCount: sentToOwner.length,
    needsReviewCount: reviewRisk.length,
    failedCount: failed.length,
    duplicateCount: duplicateEvents.length,
    suspectedDuplicateRunCount,
    suspectedDuplicateGroups,
    ownerMailFailureCount: ownerMailFailures.length,
    inventoryStaleCount: inventoryStaleRuns.length,
    ownerFeedbackCount: feedback.length,
    safeDraftAcceptanceRate: feedback.length ? Number((sendableFeedback.length / feedback.length).toFixed(2)) : null,
    needsReviewRate: recent.length ? Number((reviewRisk.length / recent.length).toFixed(2)) : 0,
    failedRate: recent.length ? Number((failed.length / recent.length).toFixed(2)) : 0,
    lastRunAt: recent[0]?.created_at || null,
    mailConnected,
    inventory: {
      exists: inventoryMeta.exists,
      path: inventoryPath,
      modifiedAt: inventoryMeta.modifiedAt,
      ageHours: Number.isFinite(inventoryAgeHours) ? Number(inventoryAgeHours.toFixed(2)) : null,
      maxAgeHours: inventoryMaxAgeHours,
      itemCount: inventoryItemCount,
      minItemCount: minInventoryItems,
      tooSmall: inventoryItemCount < minInventoryItems,
      stale: inventoryIsStale
    }
  };
  return {
    metrics,
    alerts: monitoringAlerts(metrics)
  };
}

function hasReviewRisk(run) {
  if (run.status === 'needs_review') return true;
  if (['no_inventory_match', 'weak_inventory_match', 'inventory_stale', 'no_valid_items'].includes(run.error_code)) return true;
  return (run.events || []).some((event) =>
    event.event_type === 'run_needs_review' ||
    event.event_type === 'inventory_match_no_match' ||
    event.event_type === 'inventory_stale' ||
    event.level === 'warning'
  );
}

async function buildInboundStatusSnapshot(context, limit = 25) {
  const runs = await listOfferRuns(limit, context);
  const details = await Promise.all(runs.map((run) => loadOfferRun(run.id, context)));
  return {
    generatedAt: new Date().toISOString(),
    limit,
    items: details.filter(Boolean).map(inboundStatusItem)
  };
}

function inboundStatusItem(run) {
  const inbound = run.inbound_message || {};
  const events = (run.events || []).map(inboundStatusEvent);
  const lastEvent = events.at(-1) || null;
  return {
    runId: run.id,
    inboundMessageId: run.inbound_message_id || inbound.id || null,
    receivedAt: inbound.received_at || run.created_at || null,
    createdAt: run.created_at || null,
    provider: inbound.provider || null,
    providerMessageId: inbound.provider_message_id || null,
    subject: inbound.subject || run.draft_subject || '',
    from: inbound.from_email || '',
    status: run.status,
    error_code: run.error_code || null,
    error_message: run.error_message || null,
    lastEvent,
    events: compactInboundEvents(events)
  };
}

function inboundStatusEvent(event = {}) {
  return {
    event_type: event.event_type || '',
    level: event.level || 'info',
    message: event.message || '',
    created_at: event.created_at || null
  };
}

function compactInboundEvents(events) {
  const firstReceived = events.find((event) => event.event_type === 'email_received');
  const latest = events.slice(-5);
  return [firstReceived, ...latest]
    .filter(Boolean)
    .filter((event, index, list) => list.findIndex((item) => item === event) === index);
}

function isMonitoringNoise(run, config, settings) {
  const inbound = run.inbound_message || {};
  const provider = String(inbound.provider || '').toLowerCase();
  const from = String(inbound.from_email || '').toLowerCase();
  const subject = String(inbound.subject || '').toLowerCase();
  if (isInternalOwnerDraft({
    subject: inbound.subject,
    fromEmail: inbound.from_email
  }, config, settings)) return true;
  if (provider.includes('test') || provider.includes('debug') || provider.includes('loop')) return true;
  if (from.endsWith('@example.com') || from.includes('@dealer.example')) return true;
  if (subject.includes('p0 test') || subject.includes('debug test') || subject.includes('saas ready')) return true;
  return false;
}

export function isArchivedProofRun(run) {
  return ['ignored'].includes(String(run.status || ''));
}

async function countInventoryItems(inventoryPath) {
  try {
    return (await readCsvObjects(inventoryPath)).length;
  } catch {
    return 0;
  }
}

function monitoringAlerts(metrics) {
  const alerts = [];
  if (metrics.failedCount > 0) alerts.push({ level: 'error', code: 'failed_runs', message: `${metrics.failedCount} fehlgeschlagene Runs in ${metrics.windowHours}h.` });
  if (metrics.ownerMailFailureCount > 0) alerts.push({ level: 'error', code: 'owner_mail_failed', message: `${metrics.ownerMailFailureCount} Owner-Mail-Fehler.` });
  if (metrics.inventory.stale) alerts.push({ level: 'warning', code: 'inventory_stale', message: 'Lager-/Preis-CSV ist veraltet oder fehlt.' });
  if (metrics.inventory.tooSmall) alerts.push({ level: 'error', code: 'inventory_too_small', message: `Lager-/Preis-CSV hat nur ${metrics.inventory.itemCount} Position(en). Minimum für Proof: ${metrics.inventory.minItemCount}.` });
  if (metrics.runCount >= 5 && metrics.failedRate > 0.1) alerts.push({ level: 'error', code: 'failed_rate_high', message: `Failed Rate ${(metrics.failedRate * 100).toFixed(0)}%.` });
  if (metrics.runCount >= 5 && metrics.needsReviewRate > 0.4) alerts.push({ level: 'warning', code: 'needs_review_rate_high', message: `Needs-Review Rate ${(metrics.needsReviewRate * 100).toFixed(0)}%.` });
  if (metrics.suspectedDuplicateRunCount > 0) alerts.push({ level: 'error', code: 'suspected_duplicate_runs', message: `${metrics.suspectedDuplicateRunCount} verdächtige doppelte Verarbeitung(en) im Flight Recorder.` });
  if (metrics.mailConnected && metrics.processedCount === 0) alerts.push({ level: 'warning', code: 'no_processed_mail', message: 'Mail ist verbunden, aber in 24h wurde nichts verarbeitet.' });
  return alerts;
}

export function findSuspectedDuplicateGroups(runs = []) {
  const replayDuplicateIds = findReplayDuplicateIds(runs);
  const groups = new Map();
  for (const run of runs) {
    if (replayDuplicateIds.has(run.id)) continue;
    const signature = duplicateSignature(run);
    if (!signature) continue;
    const group = groups.get(signature) || {
      signature,
      customerEmail: normalizedCustomerEmail(run),
      totalGross: Number(run.summary?.totalGross || run.pricing_json?.final_gross || run.pricing_json?.gesamt_angebot_brutto || 0),
      runIds: [],
      providerMessageIds: [],
      subjects: [],
      extraRuns: 0
    };
    group.runIds.push(run.id);
    if (run.inbound_message?.provider_message_id) group.providerMessageIds.push(run.inbound_message.provider_message_id);
    if (run.inbound_message?.subject) group.subjects.push(run.inbound_message.subject);
    group.extraRuns = Math.max(0, group.runIds.length - 1);
    groups.set(signature, group);
  }
  return [...groups.values()]
    .filter((group) => group.runIds.length > 1)
    .map((group) => ({
      ...group,
      providerMessageIds: [...new Set(group.providerMessageIds)],
      subjects: [...new Set(group.subjects)]
    }));
}

export function filterReplayDuplicateRuns(runs = []) {
  const replayDuplicateIds = findReplayDuplicateIds(runs);
  return runs.filter((run) => !replayDuplicateIds.has(run.id));
}

export function findReplayDuplicateIds(runs = []) {
  const gmailProviderMessageIds = new Set(
    runs
      .filter((run) => runProvider(run) === 'gmail')
      .map((run) => runProviderMessageId(run))
      .filter(Boolean)
  );
  const gmailSignatures = new Set(
    runs
      .filter((run) => runProvider(run) === 'gmail')
      .map((run) => duplicateSignature(run))
      .filter(Boolean)
  );
  return new Set(
    runs
      .filter((run) =>
        runProvider(run) === 'replay' &&
        (
          gmailProviderMessageIds.has(runProviderMessageId(run)) ||
          gmailSignatures.has(duplicateSignature(run))
        )
      )
      .map((run) => run.id)
      .filter(Boolean)
  );
}

function runProvider(run) {
  return String(run?.inbound_message?.provider || run?.provider || '')
    .trim()
    .toLowerCase();
}

function runProviderMessageId(run) {
  return String(run?.inbound_message?.provider_message_id || run?.provider_message_id || '')
    .trim();
}

function duplicateSignature(run) {
  const customerEmail = normalizedCustomerEmail(run);
  const lineItems = Array.isArray(run.line_items_json) ? run.line_items_json : [];
  const pricedItems = lineItems
    .map((item) => {
      const name = String(item.produkt_name_original || item.produkt_name || item.name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const price = Number(item.preis_mail_brutto_num ?? item.preis_brutto ?? item.price ?? 0);
      if (!name || !Number.isFinite(price) || price <= 0) return '';
      return `${name}:${Math.round(price * 100)}`;
    })
    .filter(Boolean)
    .sort();
  if (!customerEmail || pricedItems.length === 0) return '';
  return `${customerEmail}:${pricedItems.join('|')}`;
}

function normalizedCustomerEmail(run) {
  return String(run.customer_json?.email || run.summary?.customerEmail || run.draft?.customer_email || '')
    .trim()
    .toLowerCase();
}

async function buildSaasReadinessSnapshot(context) {
  const monitoring = await buildMonitoringSnapshot(context);
  const allRuns = await Promise.all((await listOfferRuns(1000, context)).map((run) => loadOfferRun(run.id, context)));
  const config = loadConfig();
  const settings = await loadSettings(context);
  const mailStatus = await getMailConnectionStatus(config, context);
  const runtime = await buildRuntimeReadiness({ config, settings, mailStatus });
  const proofTargetRuns = getProofTargetRuns();
  const productionRuns = filterReplayDuplicateRuns(
    allRuns.filter((run) => run && !isMonitoringNoise(run, config, settings) && !isArchivedProofRun(run))
  );
  const processedRuns = productionRuns.filter((run) => !['received', 'parsing', 'parsed', 'matching', 'pricing', 'drafting'].includes(run.status));
  const duplicateEvents = productionRuns.flatMap((run) => run.events || []).filter((event) => event.event_type === 'email_deduplicated');
  const suspectedDuplicateGroups = findSuspectedDuplicateGroups(productionRuns);
  const suspectedDuplicateRunCount = suspectedDuplicateGroups.reduce((sum, group) => sum + group.extraRuns, 0);
  const feedback = productionRuns.map((run) => run.owner_feedback || run.summary?.ownerFeedback).filter(Boolean);
  const safeFeedback = feedback.filter((item) => ['sendable', 'minor_correction'].includes(item.rating));
  const safeDraftAcceptanceRate = feedback.length ? Number((safeFeedback.length / feedback.length).toFixed(2)) : null;
  const storageMode = process.env.DATABASE_URL ? 'postgres' : 'jsonl';
  const blockers = [];
  const warnings = [];

  if (storageMode !== 'postgres') {
    blockers.push({
      code: 'storage_not_production_db',
      severity: 'p0',
      message: 'Flight Recorder nutzt noch lokale JSONL-Dateien. Für echtes Multi-Händler-SaaS braucht es Postgres/ACID/Backups.'
    });
  }
  if (!monitoring.metrics.mailConnected) {
    blockers.push({ code: 'mail_not_connected', severity: 'p0', message: 'Kein Gmail/Outlook Zugriff verbunden.' });
  }
  if (!monitoring.metrics.inventory.exists || monitoring.metrics.inventory.stale || monitoring.metrics.inventory.tooSmall) {
    blockers.push({ code: 'inventory_not_safe', severity: 'p0', message: 'Lager-/Preisquelle ist nicht frisch oder nicht ausreichend gross.' });
  }
  if (processedRuns.length < proofTargetRuns) {
    blockers.push({
      code: 'proof_mail_count_low',
      severity: 'p0',
      message: `${processedRuns.length}/${proofTargetRuns} echte verarbeitete Runs im Flight Recorder. Ziel für Verkauf: ${proofTargetRuns}.`
    });
  }
  if (feedback.length < 20) {
    blockers.push({
      code: 'owner_feedback_low',
      severity: 'p0',
      message: `${feedback.length}/20 Owner-Feedbacks erfasst. Ohne Feedback ist Draft-Qualität nicht bewiesen.`
    });
  }
  if (safeDraftAcceptanceRate !== null && safeDraftAcceptanceRate < 0.8) {
    blockers.push({
      code: 'safe_draft_acceptance_low',
      severity: 'p0',
      message: `Safe Draft Acceptance ${(safeDraftAcceptanceRate * 100).toFixed(0)}%. Ziel: mindestens 80%.`
    });
  }
  if (monitoring.metrics.failedCount > 0) {
    blockers.push({ code: 'recent_failed_runs', severity: 'p0', message: 'Es gibt fehlgeschlagene Runs im 24h-Fenster.' });
  }
  if (monitoring.metrics.ownerMailFailureCount > 0) {
    blockers.push({ code: 'owner_delivery_failed', severity: 'p0', message: 'Owner-Mail-Zustellung hatte Fehler.' });
  }
  if (duplicateEvents.length > 0) {
    warnings.push({
      code: 'duplicates_seen',
      severity: 'p1',
      message: `${duplicateEvents.length} Duplikate wurden erkannt und blockiert. Das ist ok, aber beim Proof beobachten.`
    });
  }
  if (suspectedDuplicateRunCount > 0) {
    blockers.push({
      code: 'suspected_duplicate_runs',
      severity: 'p0',
      message: `${suspectedDuplicateRunCount} verdächtige doppelte Verarbeitung(en) im Flight Recorder. Proof-Kriterium ist 0.`
    });
  }
  if (safeDraftAcceptanceRate === null) {
    warnings.push({
      code: 'safe_draft_acceptance_unknown',
      severity: 'p1',
      message: 'Safe Draft Acceptance ist unbekannt, weil noch kein Owner-Feedback gespeichert wurde.'
    });
  }
  blockers.push(...runtime.blockers);
  warnings.push(...runtime.warnings);

  const daltecDailyUseCandidate =
    monitoring.metrics.mailConnected &&
    monitoring.metrics.inventory.exists &&
    !monitoring.metrics.inventory.stale &&
    !monitoring.metrics.inventory.tooSmall &&
    monitoring.metrics.failedCount === 0 &&
    monitoring.metrics.ownerMailFailureCount === 0;

  return {
    generatedAt: new Date().toISOString(),
    tenantId: context.tenantId,
    storageMode,
    daltecDailyUseCandidate,
    sellableSaas: blockers.length === 0,
    status: blockers.length === 0 ? 'sellable_saas_ready' : (daltecDailyUseCandidate ? 'daltec_proof_running_not_sellable' : 'blocked'),
    metrics: {
      productionRuns: productionRuns.length,
      processedRuns: processedRuns.length,
      proofTargetRuns,
      suspectedDuplicateRunCount,
      ownerFeedbackCount: feedback.length,
      ownerFeedbackTarget: 20,
      safeDraftAcceptanceRate,
      recent: monitoring.metrics
    },
    runtime,
    blockers,
    warnings,
    nextAction: blockers[0]?.message || warnings[0]?.message || 'Pilot kann verkauft werden. Weiter nur über Feedback und Monitoring skalieren.'
  };
}

async function buildReviewQueue(context) {
  const config = loadConfig();
  const settings = await loadSettings(context);
  const runs = await listOfferRuns(250, context);
  const details = await Promise.all(runs.map((run) => loadOfferRun(run.id, context)));
  const items = details
    .filter(Boolean)
    .filter((run) => !isMonitoringNoise(run, config, settings))
    .filter((run) => !isArchivedProofRun(run))
    .filter((run) => ['completed', 'sent_to_owner', 'needs_review'].includes(run.status))
    .filter((run) => run.draft || run.draft_html)
    .filter((run) => !(run.owner_feedback || run.summary?.ownerFeedback))
    .map(reviewQueueItem)
    .sort((a, b) => b.priority - a.priority || String(b.created_at).localeCompare(String(a.created_at)));

  const feedbackCount = details
    .filter(Boolean)
    .filter((run) => !isMonitoringNoise(run, config, settings))
    .filter((run) => !isArchivedProofRun(run))
    .filter((run) => run.owner_feedback || run.summary?.ownerFeedback)
    .length;

  return {
    generatedAt: new Date().toISOString(),
    tenantId: context.tenantId,
    openCount: items.length,
    feedbackCount,
    targetFeedbackCount: 20,
    items
  };
}

async function sendReviewQueueDigest(context, options = {}) {
  const settings = await loadSettings(context);
  const config = loadConfig();
  const queue = await buildReviewQueue(context);
  const items = queue.items.slice(0, Math.max(1, Number(options.limit || 20)));
  const to = settings.mail?.to || config.gmail.to;
  const cc = config.gmail.cc;
  const subject = `Eduard Review Queue: ${items.length} offene Bewertungen`;
  const html = reviewDigestHtml(items, { config, settings, context, auth: options.auth || authConfig() });

  if (!items.length) {
    return { delivered: false, dryRun: Boolean(options.dryRun), reason: 'empty_queue', to, cc, subject, count: 0, html };
  }

  if (!options.dryRun) {
    const runtime = await createMailRuntime({
      ...config,
      gmail: {
        ...config.gmail,
        to,
        cc
      }
    }, context);
    await runtime.sendHtmlMail(runtime.client, { to, cc, subject, html });
    await Promise.all(items.map((item) => appendOfferRunEvent(item.id, {
      event_type: 'review_digest_sent',
      level: 'info',
      message: `Review digest sent to ${to}`,
      metadata: { to, cc, subject }
    }, context)));
    return { delivered: true, dryRun: false, provider: runtime.provider, to, cc, subject, count: items.length };
  }

  return { delivered: false, dryRun: true, to, cc, subject, count: items.length, html };
}

function reviewDigestHtml(items, { config, context, auth }) {
  const baseUrl = String(config.app?.baseUrl || '').replace(/\/$/, '');
  const rows = items.map((item, index) => reviewDigestRow(item, index, { baseUrl, context, auth })).join('');
  return `<!doctype html>
    <html lang="de">
      <head><meta charset="utf-8"></head>
      <body style="margin:0;background:#f3f4f6;padding:16px;font-family:Arial,sans-serif;color:#111827;">
        <div style="max-width:880px;margin:0 auto;background:#ffffff;border:1px solid #e1e5eb;border-radius:8px;overflow:hidden;">
          <div style="padding:14px 16px;border-bottom:1px solid #e1e5eb;">
            <h1 style="font-size:20px;line-height:1.2;margin:0 0 4px;">Eduard Review Queue</h1>
            <p style="margin:0;color:#667085;font-size:13px;">Bitte jeden Entwurf bewerten. Das ist die Messung für Safe Draft Acceptance.</p>
          </div>
          <div style="display:grid;gap:10px;padding:12px;">
            ${rows}
          </div>
        </div>
      </body>
    </html>`;
}

function reviewDigestRow(item, index, { baseUrl, context, auth }) {
  const reason = item.errorMessage || item.match?.matched || item.subject || 'Entwurf prüfen';
  const buttons = [
    ['sendable', 'Sendbar'],
    ['minor_correction', 'Kleine Korrektur'],
    ['wrong', 'Falsch']
  ].map(([rating, label]) => {
    const token = createFeedbackToken({ tenantId: context.tenantId, runId: item.id, rating }, auth.sessionSecret);
    const href = `${baseUrl}/feedback?token=${encodeURIComponent(token)}`;
    const bg = rating === 'wrong' ? '#b42318' : rating === 'minor_correction' ? '#ffffff' : '#111827';
    const color = rating === 'minor_correction' ? '#111827' : '#ffffff';
    return `<a href="${href}" style="display:inline-block;margin:0 6px 6px 0;padding:9px 10px;border-radius:6px;background:${bg};color:${color};border:1px solid #d4dae3;text-decoration:none;font-weight:bold;font-size:12px;">${escapeHtml(label)}</a>`;
  }).join('');
  return `<section style="border:1px solid #e7ebf0;border-radius:8px;background:${item.errorCode ? '#fffbeb' : '#f8fafc'};padding:10px;">
    <p style="margin:0 0 4px;font-size:13px;"><strong>${index + 1}. ${escapeHtml(item.customerName || item.customerEmail || 'Unbekannter Kunde')}</strong></p>
    <p style="margin:0 0 6px;color:#475467;font-size:12px;">${escapeHtml(reason)}</p>
    <p style="margin:0 0 8px;color:#667085;font-size:12px;">Status: ${escapeHtml(item.status)} | Match: ${escapeHtml(item.match?.confidence || '-')} | Summe: ${escapeHtml(formatEuro(item.totalGross))}</p>
    ${buttons}
  </section>`;
}

function formatEuro(value) {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeCustomerSendPayload(input = {}) {
  const to = String(input.to || '').trim();
  const subject = String(input.subject || '').trim();
  const hasEditableOffer = Object.hasOwn(input, 'editable_offer');
  if (!to) {
    const error = new Error('to_required');
    error.statusCode = 400;
    throw error;
  }
  if (!subject) {
    const error = new Error('subject_required');
    error.statusCode = 400;
    throw error;
  }
  if (!hasEditableOffer) {
    const error = new Error('editable_offer_required');
    error.statusCode = 400;
    throw error;
  }
  return {
    to,
    to,
    subject,
    editable_offer: normalizeEditableOffer(input.editable_offer || {})
  };
}

function isFinalOfferRun(run = {}) {
  return ['sent_to_customer', 'rejected'].includes(run.status);
}

function renderEditableOfferForRun(run, editableOfferInput = {}, settings = {}) {
  const state = editableOfferStateWithContentDefaults(run, editableOfferInput, settings);
  const inventory = state.tables.inventory_alternative;
  return {
    html: renderEditableOfferHtml(state),
    normalized_editable_offer: state.editable_offer,
    review_state: buildReviewStateForRun(run, state),
    summary: {
      tableCount: inventory.enabled ? 2 : 1,
      inventorySource: inventory.enabled ? inventory.active_source || null : null,
      inventoryHeading: inventory.enabled ? inventory.heading || null : null
    }
  };
}

function editableOfferStateWithContentDefaults(run, editableOfferInput = {}, settings = {}) {
  return buildEditableOfferState(run, {
    editable_offer: editableOfferInputWithContentDefaults(run, editableOfferInput, settings)
  });
}

function editableOfferInputWithContentDefaults(run = {}, editableOfferInput = {}, settings = {}) {
  const input = editableOfferInput && typeof editableOfferInput === 'object' ? editableOfferInput : {};
  const persisted = run.summary?.editable_offer || {};
  const defaults = editableContentDefaults(run, settings);
  const result = { ...input };
  for (const field of ['intro', 'notes', 'signature']) {
    if (!hasText(input[field]) && !hasText(persisted[field]) && hasText(defaults[field])) {
      result[field] = defaults[field];
    }
  }
  return result;
}

function editableContentDefaults(run = {}, settings = {}) {
  const draftHtml = run.draft?.html_body || '';
  return {
    intro: firstParagraphBeforeTable(draftHtml) || settings.mail_defaults?.introTemplate || '',
    notes: settings.mail?.copyQuestion || settings.mail_defaults?.defaultNotes || '',
    signature: signatureTextFromSettings(settings) || settings.mail_defaults?.signature || ''
  };
}

function firstParagraphBeforeTable(html = '') {
  const beforeTable = String(html || '').split(/<table\b/i)[0] || '';
  const paragraphs = [...beforeTable.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => textFromHtml(match[1]))
    .filter(Boolean)
    .filter((text) => !/^Kunden E-Mail kopieren:/i.test(text));
  return paragraphs.at(-1) || '';
}

function signatureTextFromSettings(settings = {}) {
  const signature = settings.signature || {};
  const lines = [
    signature.greeting || 'Beste Grüße',
    '',
    signature.name,
    signature.company,
    signature.address1,
    signature.address2,
    signature.phone,
    signature.email,
    signature.website
  ].map((line) => String(line || '').trim());
  return lines.some(Boolean) ? lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

function textFromHtml(html = '') {
  return decodeHtmlEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function buildReviewStateForRun(run, state = buildEditableOfferState(run, { editable_offer: run.summary?.editable_offer || {} })) {
  const customer = run.customer_json || {};
  const customerName = run.summary?.customerName || [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const inventory = state.tables.inventory_alternative || {};
  const editableOffer = state.editable_offer || {};
  const extraTables = inventory.enabled && inventory.table ? [reviewExtraTableFromRenderTable(inventory.table)] : [];
  const inventoryAlternative = editableOffer.inventory_alternative || {};
  const to = editableOffer.to || state.recipient.to || run.summary?.customerEmail || customer.email || run.draft?.customer_email || '';
  const subject = editableOffer.subject || state.recipient.subject || run.draft?.subject || run.draft_subject || '';
  const rows = Array.isArray(editableOffer.rows) && editableOffer.rows.length
    ? editableOffer.rows
    : (state.tables.requested?.rows || []).map(reviewRowFromRenderRow);
  return {
    customerName,
    to,
    subject,
    intro: state.content.intro || '',
    notes: state.content.notes || '',
    signature: state.content.signature || '',
    rows: rows.length ? rows : reviewRowsFromRun(run),
    extra_tables: extraTables,
    extraTables,
    baseExtraTables: extraTables,
    inventoryReplacement: reviewInventoryReplacement(inventoryAlternative.replacement),
    version: Number(run.summary?.editable_offer_version || 1),
    catalog: reviewCatalogFromRun(run),
    inventoryAlternativeAvailable: inventory.suggested === true || Boolean(inventory.table),
    inventoryAlternativeEnabled: inventory.enabled === true,
    inventoryAlternativeName: inventory.source?.top_lager_name || inventory.table?.intro?.replace(/^Passendes Lagerfahrzeug:\s*/, '') || ''
  };
}

function reviewInventoryReplacement(input = {}) {
  return {
    enabled: input?.enabled === true,
    inventory_sku: String(input?.inventory_sku || '').trim(),
    inventory_name: String(input?.inventory_name || '').trim(),
    reason: String(input?.reason || '').trim()
  };
}

function reviewExtraTableFromRenderTable(table) {
  return {
    title: table.title || '',
    intro: table.intro || '',
    rows: (table.rows || []).map((row) => ({
      product: row.product || '',
      uvp: row.uvp || '',
      discount: row.discount || '',
      offer: row.offer || '',
      type: row.type || 'item'
    }))
  };
}

function reviewRowFromRenderRow(row) {
  return {
    type: row.type || 'item',
    product: row.product || '',
    uvpNet: reviewPriceInput(row.uvp),
    discount: reviewPriceInput(row.discount),
    offerNet: reviewPriceInput(row.offer)
  };
}

function reviewRowsFromRun(run) {
  const pricing = run.pricing_json || {};
  const positions = Array.isArray(pricing.positionen) ? pricing.positionen : [];
  const lineItems = Array.isArray(run.line_items_json) ? run.line_items_json : [];
  const rows = positions.length
    ? positions.map((position) => {
      const uvpNet = Number(position.uvp_netto || 0);
      const offerNet = Number(position.angebot_netto || 0);
      return {
        type: 'item',
        product: position.produkt_name || 'Produkt',
        uvpNet: formatReviewPriceInput(uvpNet),
        discount: formatReviewPriceInput(uvpNet - offerNet),
        offerNet: formatReviewPriceInput(offerNet)
      };
    })
    : lineItems.map((item) => {
      const net = Number(item.preis_mail_brutto_num || item.price || 0) / 1.2;
      return {
        type: 'item',
        product: item.produkt_name_original || item.name || item.produkt || 'Produkt',
        uvpNet: formatReviewPriceInput(net),
        discount: formatReviewPriceInput(0),
        offerNet: formatReviewPriceInput(net)
      };
    });
  rows.push(
    { type: 'total', product: 'Gesamt netto', uvpNet: '0,00', discount: '0,00', offerNet: '0,00' },
    { type: 'vat', product: '20% MwSt', uvpNet: '0,00', discount: '0,00', offerNet: '0,00' },
    { type: 'gross', product: 'Gesamt Brutto (inkl. MwSt.)', uvpNet: '0,00', discount: '0,00', offerNet: '0,00' }
  );
  return rows;
}

function formatReviewPriceInput(value) {
  return new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function reviewPriceInput(value) {
  return String(value || '').replace(/[^\d,.-]/g, '').trim();
}

function reviewCatalogFromRun(run) {
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

function reviewQueueItem(run) {
  const match = run.match_json || run.summary || {};
  const pricing = run.pricing_json || {};
  const warnings = [
    ...(Array.isArray(match.warnings) ? match.warnings : []),
    ...(Array.isArray(pricing.warnings) ? pricing.warnings : [])
  ];
  const reasonCodes = warnings.map((warning) => warning.code).filter(Boolean);
  const isNeedsReview = run.status === 'needs_review' || Boolean(run.error_code);
  const weakMatch = run.error_code === 'weak_inventory_match' || match.confidence === 'low' || Number(match.matchScore || 0) < 1000;
  const noMatch = run.error_code === 'no_inventory_match' || match.hasInventoryMatch === false;
  const priceWarning = warnings.some((warning) => String(warning.code || '').includes('price') || warning.code === 'negative_discount');
  const priority =
    (isNeedsReview ? 100 : 0) +
    (noMatch ? 40 : 0) +
    (weakMatch ? 30 : 0) +
    (priceWarning ? 25 : 0) +
    warnings.length;

  return {
    id: run.id,
    created_at: run.created_at,
    status: run.status,
    priority,
    customerName: run.summary?.customerName || '',
    customerEmail: run.summary?.customerEmail || run.customer_json?.email || '',
    subject: run.inbound_message?.subject || run.draft?.subject || run.draft_subject || '',
    totalGross: run.summary?.totalGross || pricing.final_gross || pricing.gesamt_angebot_brutto || 0,
    errorCode: run.error_code || null,
    errorMessage: run.error_message || null,
    match: {
      confidence: match.confidence || confidenceLabel(match.matchConfidence, match.matchScore ?? match.score),
      matchType: match.matchType || null,
      matchScore: match.matchScore ?? match.score ?? null,
      requested: [match.requested_type, match.requested_length, match.requested_width, match.requested_weight].filter(Boolean).join(' / '),
      matched: match.matched_item || match.topInventoryName || null,
      stockQty: match.stock_qty ?? null
    },
    warnings: reasonCodes,
    nextAction: isNeedsReview
      ? 'Prüfen und Feedback setzen'
      : 'Sendbarkeit bestätigen'
  };
}

function confidenceLabel(value, score) {
  if (value !== undefined && value !== null && value !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (numeric >= 0.95) return 'high';
      if (numeric >= 0.48) return 'medium';
      if (numeric > 0) return 'low';
    }
  }
  const numericScore = Number(score || 0);
  if (numericScore >= 2000) return 'high';
  if (numericScore >= 1000) return 'medium';
  if (numericScore > 0) return 'low';
  return null;
}

export async function buildGmailProofAnalysis(options = {}) {
  const limit = clampNumber(options.limit, 1, 200, 50);
  const settings = options.settings || await loadSettings(tenantContext({ tenantId: options.tenantId }));
  const report = await exportGmailMessages({
    tenantId: options.tenantId,
    limit,
    query: options.query,
    proofOnly: options.proofOnly !== false
  });
  const productCounts = new Map();
  const messages = report.messages.map((message) => {
    const inquiry = extractInquiry({
      subject: message.subject,
      text: message.rawText,
      html: message.rawHtml
    });
    const products = (inquiry.line_items || [])
      .map((item) => {
        const name = String(item.produkt_name_original || '').trim();
        if (!name) return null;
        const category = resolveProductCategory(name, settings.pricing);
        const key = `${category}\u0000${name}`;
        const existing = productCounts.get(key) || { name, category, count: 0 };
        existing.count += 1;
        productCounts.set(key, existing);
        return {
          name,
          category,
          price: Number(item.preis_mail_brutto_num || 0),
          unsupportedCurrency: item.unsupported_currency || null,
          isSkuNotFound: item.is_sku_not_found === true
        };
      })
      .filter(Boolean);
    return {
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      fromDomain: emailDomain(message.fromEmail),
      receivedAt: message.receivedAt,
      customerDetected: Boolean(inquiry.kunde_email || inquiry.kunde_vorname || inquiry.kunde_nachname),
      productCount: products.length,
      products
    };
  });
  const productsByCategory = {};
  for (const product of productCounts.values()) {
    productsByCategory[product.category] ||= [];
    productsByCategory[product.category].push(product);
  }
  for (const products of Object.values(productsByCategory)) {
    products.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  return {
    query: report.query,
    limit,
    messageCount: messages.length,
    productNameCount: productCounts.size,
    productsByCategory,
    messages
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function emailDomain(value) {
  const match = String(value || '').match(/@([^>\s]+)/);
  return match ? match[1].toLowerCase() : '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAdminApp();
  app.listen(port, () => {
    console.log(`Admin UI: http://localhost:${port}`);
  });
}

