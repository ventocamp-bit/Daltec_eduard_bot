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
import { runWorkflow } from '../workflow.js';
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
import { listInventoryImports } from '../inventory-import.js';
import {
  buildReviewQueue as buildSharedReviewQueue,
  sendReviewQueueDigest as sendSharedReviewQueueDigest
} from '../review-digest.js';
import {
  appendOfferRunEvent,
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

export function createAdminApp(options = {}) {
  const app = express();
  const auth = options.auth || authConfig();
  const gmailProofAnalyzer = options.gmailProofAnalyzer || buildGmailProofAnalysis;

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (email !== auth.email || !verifyPassword(password, auth.secret)) {
      res.status(401).json({ error: 'Login fehlgeschlagen' });
      return;
    }

    const { token, session } = createSession(email, auth);
    res.setHeader('Set-Cookie', sessionCookie(token, auth));
    res.json({ email: session.email, expiresAt: session.expiresAt });
  });

  app.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (email !== auth.email || !verifyPassword(password, auth.secret)) {
      res.redirect('/?login=failed');
      return;
    }

    const { token } = createSession(email, auth);
    res.setHeader('Set-Cookie', sessionCookie(token, auth));
    res.redirect('/');
  });

  app.get('/login/local', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).send('Not found');
      return;
    }

    const { token } = createSession(auth.email, auth);
    res.setHeader('Set-Cookie', sessionCookie(token, auth));
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
    res.json({ email: session.email, expiresAt: session.expiresAt });
  });

  app.get('/api/oauth/google/callback', async (req, res, next) => {
  try {
    await completeGoogleConnect(loadConfig(), req.query.code, req.query.state, auth.sessionSecret);
    res.redirect('/?mail_connected=gmail');
  } catch (error) {
    next(error);
  }
  });

  app.get('/api/oauth/microsoft/callback', async (req, res, next) => {
  try {
    await completeMicrosoftConnect(loadConfig(), req.query.code, req.query.state, auth.sessionSecret);
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
    req.session = session;
    req.tenantContext = tenantContext({ tenantId: session.tenantId });
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

  app.post('/api/preview', async (req, res, next) => {
  try {
    const settings = req.body.settings || await loadSettings(req.tenantContext);
    delete settings.mail?.cc;
    if (settings.mail?.internalSubject && !settings.mail.subject) {
      settings.mail.subject = settings.mail.internalSubject;
    }
    delete settings.mail?.internalSubject;
    const message = req.body.message || sampleMessage();
    const result = runWorkflow(message, { settings });
    res.json(result.offer);
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
  const groups = new Map();
  for (const run of runs) {
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
  const productionRuns = allRuns.filter((run) => run && !isMonitoringNoise(run, config, settings) && !isArchivedProofRun(run));
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
  if (processedRuns.length < 100) {
    blockers.push({
      code: 'proof_mail_count_low',
      severity: 'p0',
      message: `${processedRuns.length}/100 echte verarbeitete Runs im Flight Recorder. Ziel für Verkauf: 100.`
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
      proofTargetRuns: 100,
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

function sampleMessage() {
  return {
    subject: 'Eduard Anfrage',
    text: [
      'Vorname  Max',
      'Nachname  Mustermann',
      'E-mail-Adresse  max@example.com',
      'Hochlader 3318 3500kg  EUR 3.000,00'
    ].join('\n'),
    html: [
      '<table>',
      '<tr><td><strong>Vorname</strong></td><td>Max</td></tr>',
      '<tr><td><strong>Nachname</strong></td><td>Mustermann</td></tr>',
      '<tr><td><strong>E-mail-Adresse</strong></td><td>max@example.com</td></tr>',
      '<tr><td>Hochlader 3318 3500kg</td><td>&euro; 3.000,00</td></tr>',
      '<tr><td>COC & Typisierung</td><td>&euro; 200,00</td></tr>',
      '</table>'
    ].join('')
  };
}
