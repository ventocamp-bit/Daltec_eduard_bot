import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { loadSettings } from './settings.js';
import { isEduardInquiry, runWorkflow } from './workflow.js';
import { DEFAULT_TENANT_ID, listTenantContexts, tenantContext } from './tenant-context.js';
import { processOfferRun } from './offer-run-service.js';
import { createMailRuntime } from './mail-runtime.js';
import { loadMailConnections } from './mail-connections.js';
import { fetchUnseenImapMessages } from './core/imap-poller.js';
import { deliverRunDraftToOwner } from './owner-delivery.js';
import { sendReviewReminderIfDue } from './review-digest.js';
import { resolveTenantContextForInbound } from './dealer-routing.js';
import { isInternalOwnerDraft } from './internal-mail.js';
import { labelForIgnoredRun, labelForProcessedRun } from './mail-labels.js';
import {
  buildInventoryImportFailureMail,
  isInventoryImportMessage,
  markInventoryImportReplyMailFailed,
  processInventoryImportMessage
} from './inventory-import.js';
import {
  appendOfferRunEvent,
  ingestInboundMessage,
  loadOfferRun,
  updateOfferRun
} from './storage.js';

dotenv.config();

const config = loadConfig();
const command = process.argv[2] || 'run-once';
const defaultTenantContext = tenantContext({ tenantId: process.env.ADMIN_TENANT_ID || 'daltec-local' });

async function main() {
  if (command === 'dry-run') {
    const file = argValue('--file');
    if (!file) throw new Error('Bitte --file mit einer gespeicherten Mail angeben.');
    const message = JSON.parse(await fs.readFile(file, 'utf8'));
    const result = runWorkflow(message, {
      lagerBestand: [],
      preisliste: [],
      tenantContext: defaultTenantContext
    });
    console.log(JSON.stringify(result.offer, null, 2));
    return;
  }

  if (command === 'run-once') {
    await runOnce();
    return;
  }

  if (command === 'poll') {
    await runOnceSafely();
    setInterval(runOnceSafely, config.gmail.pollMinutes * 60 * 1000);
    return;
  }

  throw new Error(`Unbekannter Befehl: ${command}`);
}

async function runOnce() {
  const errors = [];
  try {
    await pollCentralForwardingInbox();
  } catch (error) {
    errors.push(error);
    console.error(`[poll:central] ${error.message}`);
  }
  await pollConnectedTenantInboxes();
  if (errors.length) throw new Error(`poll_partial_failure: ${errors.map((error) => error.message).join(' | ')}`);
}

async function pollCentralForwardingInbox() {
  const settings = await loadSettings(defaultTenantContext);
  const effectiveConfig = {
    ...config,
    gmail: {
      ...config.gmail,
      to: settings.mail?.to || config.gmail.to,
      cc: 'ventocamp@gmail.com',
      subject: settings.mail?.subject || settings.mail?.internalSubject || config.gmail.subject
    }
  };
  const mailRuntime = await createMailRuntime(effectiveConfig, defaultTenantContext, { allowLegacyGoogleToken: true });
  const messages = await fetchPollMessages(mailRuntime, effectiveConfig);

  for (const message of messages) {
    try {
      await processMailMessage(message, mailRuntime, effectiveConfig, settings);
    } catch (error) {
      console.error(`[message] ${message.id}: ${error.message}`);
      await mailRuntime.labelMessage(mailRuntime.client, message.id, 'Eduard/failed').catch(() => null);
    }
  }
}

async function pollConnectedTenantInboxes() {
  const contexts = await listTenantContexts();
  for (const context of contexts) {
    if (context.tenantId === DEFAULT_TENANT_ID) continue;
    let settings = null;
    try {
      settings = await loadSettings(context);
      await pollTenantImapInbox(context, settings);

      const connections = await loadMailConnections(context);
      if (!connections.gmail?.token && !connections.outlook?.token) continue;

      const effectiveConfig = {
        ...config,
        gmail: {
          ...config.gmail,
          to: settings.mail?.to || config.gmail.to,
          cc: 'ventocamp@gmail.com',
          subject: settings.mail?.subject || settings.mail?.internalSubject || config.gmail.subject
        }
      };
      const mailRuntime = await createMailRuntime(effectiveConfig, context, { allowLegacyGoogleToken: false });
      const messages = await fetchPollMessages(mailRuntime, effectiveConfig);

      for (const message of messages) {
        try {
          await processMailMessage(message, mailRuntime, effectiveConfig, settings, { forcedTenantContext: context });
        } catch (error) {
          console.error(`[message:${context.tenantId}] ${message.id}: ${error.message}`);
          await mailRuntime.labelMessage(mailRuntime.client, message.id, 'Eduard/failed').catch(() => null);
        }
      }
    } catch (error) {
      console.error(`[poll:${context.tenantId}] ${sanitizePollError(error.message, settings?.imap)}`);
    }
  }
}

async function pollTenantImapInbox(context, settings) {
  if (!settings.imap?.email || !settings.imap?.app_password) return;
  const effectiveConfig = {
    ...config,
    gmail: {
      ...config.gmail,
      to: settings.mail?.to || config.gmail.to,
      cc: 'ventocamp@gmail.com',
      subject: settings.mail?.subject || settings.mail?.internalSubject || config.gmail.subject
    }
  };
  const mailRuntime = {
    provider: 'imap',
    client: null,
    labelMessage: async () => null,
    markMessageRead: async () => null,
    sendHtmlMail: async () => {
      const error = new Error('imap_send_not_supported');
      error.statusCode = 400;
      throw error;
    }
  };
  const messages = await fetchUnseenImapMessages(settings.imap);
  for (const message of messages) {
    await processMailMessage(message, mailRuntime, effectiveConfig, settings, { forcedTenantContext: context });
  }
}

async function fetchPollMessages(mailRuntime, effectiveConfig) {
  const messages = await mailRuntime.fetchUnreadMessages(mailRuntime.client, effectiveConfig);
  if (mailRuntime.provider !== 'gmail') return messages;
  const inventoryMessages = await mailRuntime.fetchUnreadMessages(mailRuntime.client, {
    ...effectiveConfig,
    gmail: {
      ...effectiveConfig.gmail,
      query: effectiveConfig.gmail.inventoryQuery || 'is:unread has:attachment {lager bestand inventory stock lagerliste fahrzeugliste}'
    }
  }).catch(() => []);
  const byId = new Map();
  for (const message of [...messages, ...inventoryMessages]) byId.set(message.id, message);
  return [...byId.values()];
}

export async function processMailMessage(message, mailRuntime, effectiveConfig, settings, options = {}) {
    if (isInternalOwnerDraft(message, effectiveConfig, settings)) {
      await mailRuntime.labelMessage(mailRuntime.client, message.id, labelForIgnoredRun('internal'));
      await mailRuntime.markMessageRead(mailRuntime.client, message.id);
      console.log(`Interne Angebotsmail ignoriert: ${message.id}`);
      return;
    }
    const messageContext = options.forcedTenantContext || await resolveTenantContextForInbound({
      fromEmail: message.from || '',
      toEmail: message.to || '',
      subject: message.subject || '',
      rawHtml: message.html || '',
      rawText: message.text || ''
    });
    const messageSettings = await loadSettings(messageContext);

    if (isInventoryImportMessage(message, messageSettings)) {
      const result = await processInventoryImportMessage(message, messageSettings, messageContext);
      if (!result.ok) {
        const reply = buildInventoryImportFailureMail(result, messageSettings);
        const to = extractEmailAddress(message.from);
        if (to) {
          await mailRuntime.sendHtmlMail(mailRuntime.client, {
            to,
            cc: messageSettings.mail?.to || effectiveConfig.gmail.to,
            subject: reply.subject,
            html: reply.html
          }).catch(async (error) => {
            await markInventoryImportReplyMailFailed(messageContext, result.import?.id);
            console.error(`[inventory-import-reply] ${message.id}: ${error.message}`);
          });
        }
        await mailRuntime.labelMessage(mailRuntime.client, message.id, 'Eduard/inventory-import-failed').catch(() => null);
      } else {
        await mailRuntime.labelMessage(mailRuntime.client, message.id, 'Eduard/inventory-imported').catch(() => null);
      }
      await mailRuntime.markMessageRead(mailRuntime.client, message.id);
      console.log(`Lagerimport: ${message.id} -> ${result.ok ? 'ok' : 'failed'}`);
      return;
    }

    const inbound = await ingestInboundMessage({
      provider: mailRuntime.provider,
      provider_message_id: message.id,
      subject: message.subject || '',
      from_email: message.from || '',
      to_email: message.to || '',
      received_at: message.received_at || new Date().toISOString(),
      raw_html: message.html || '',
      raw_text: message.text || ''
    }, messageContext);

    if (inbound.duplicate) {
      await mailRuntime.labelMessage(mailRuntime.client, message.id, labelForIgnoredRun('duplicate'));
      await mailRuntime.markMessageRead(mailRuntime.client, message.id);
      console.log(`Duplikat ignoriert: ${message.id}`);
      return;
    }

    if (!isEduardInquiry(message, effectiveConfig.gmail.subjectFilter)) {
      await updateOfferRun(inbound.run.id, {
        status: 'ignored',
        completed_at: new Date().toISOString(),
        error_code: 'ignored_not_eduard',
        error_message: 'Betreff passt nicht zum Eduard-Filter.'
      }, messageContext);
      await appendOfferRunEvent(inbound.run.id, {
        event_type: 'ignored_not_eduard',
        level: 'info',
        message: 'Message ignored because subject did not match Eduard filter',
        metadata: { subject: message.subject || '' }
      }, messageContext);
      await mailRuntime.labelMessage(mailRuntime.client, message.id, labelForIgnoredRun('not_eduard'));
      await mailRuntime.markMessageRead(mailRuntime.client, message.id);
      console.log(`Ignoriert: ${message.id}`);
      return;
    }

    const processed = await processOfferRun(inbound.run.id, messageContext);
    const currentRun = await loadOfferRun(inbound.run.id, messageContext);
    if (!currentRun?.draft?.html_body) {
      await appendOfferRunEvent(inbound.run.id, {
        event_type: 'draft_missing',
        level: 'error',
        message: 'No draft was available for sending'
      }, messageContext);
      await mailRuntime.labelMessage(mailRuntime.client, message.id, 'Eduard/failed');
      await mailRuntime.markMessageRead(mailRuntime.client, message.id);
      return;
    }
    await deliverRunDraftToOwner(currentRun, messageSettings, messageContext);
    await mailRuntime.labelMessage(mailRuntime.client, message.id, labelForProcessedRun(processed.status, currentRun));
    await mailRuntime.markMessageRead(mailRuntime.client, message.id);
    console.log(`Verarbeitet: ${message.id} -> owner (${processed.status})`);
}

function extractEmailAddress(value) {
  const match = String(value || '').match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  return match ? match[1] : '';
}

function sanitizePollError(message, imap = {}) {
  let safe = String(message || '');
  for (const secret of [imap?.app_password, imap?.password].filter(Boolean)) {
    safe = safe.split(String(secret)).join('***');
  }
  return safe;
}

async function runOnceSafely() {
  try {
    await runOnce();
    const reminder = await sendReviewReminderIfDue(defaultTenantContext);
    if (reminder.delivered) {
      console.log(`[review] Digest reminder sent: ${reminder.count}`);
    } else if (!['disabled', 'cooldown', 'empty_or_below_minimum'].includes(reminder.reason)) {
      console.log(`[review] Digest reminder skipped: ${reminder.reason}`);
    }
  } catch (error) {
    console.error(`[poll] ${error.message}`);
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
