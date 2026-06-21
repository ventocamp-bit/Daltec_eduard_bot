import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { tenantContext } from './tenant-context.js';
import { createGoogleClients } from './adapters/google.js';
import { searchMessages } from './adapters/google.js';
import { extractInquiry } from './core/parser.js';
import { isInternalOwnerDraft } from './internal-mail.js';

dotenv.config();

const args = parseArgs(process.argv.slice(2));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/export-mails.js')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export async function exportGmailMessages(options = {}) {
  const config = loadConfig();
  const context = tenantContext({ tenantId: options.tenantId || process.env.ADMIN_TENANT_ID || 'daltec-local' });
  const { gmail } = await createGoogleClients(config, context);
  const query = options.query || defaultExportQuery(config);
  const limit = Number(options.limit || 20);
  const messages = await searchMessages(gmail, query, limit);
  const selected = options.proofOnly ? messages.filter((message) => isProofCandidate(message, config)) : messages;
  const exported = selected.slice(0, limit).map((message) => ({
    provider: 'gmail',
    providerMessageId: message.id,
    subject: message.subject,
    fromEmail: message.from,
    toEmail: message.to,
    receivedAt: message.received_at || new Date().toISOString(),
    rawHtml: message.html || '',
    rawText: message.text || ''
  }));

  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  }

  return {
    query,
    limit,
    count: exported.length,
    out: options.out || null,
    messages: exported
  };
}

async function main() {
  const report = await exportGmailMessages({
    tenantId: args.tenant,
    query: args.query,
    limit: args.limit || 20,
    out: args.out || `data/replay-exports/gmail-${Date.now()}.json`,
    proofOnly: args['proof-only'] === true || args['proof-only'] === 'true'
  });
  console.log(JSON.stringify({
    query: report.query,
    limit: report.limit,
    count: report.count,
    out: report.out,
    proofOnly: args['proof-only'] === true || args['proof-only'] === 'true',
    sample: report.messages.slice(0, 3).map((message) => ({
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      fromEmail: message.fromEmail
    }))
  }, null, 2));
}

export function defaultExportQuery(config) {
  const parts = [];
  if (config.gmail.subjectFilter) parts.push(`subject:${config.gmail.subjectFilter}`);
  if (config.gmail.subject) parts.push(`-subject:"${config.gmail.subject}"`);
  if (config.gmail.cc) parts.push(`-from:${config.gmail.cc}`);
  return parts.join(' ') || 'subject:Eduard';
}

export function isProofCandidate(message, config) {
  const subject = String(message.subject || '');
  const from = String(message.from || '');
  const text = [message.text, htmlToText(message.html)].filter(Boolean).join('\n');
  const normalizedSubject = subject.toLowerCase();
  const normalizedFrom = from.toLowerCase();
  if (isInternalOwnerDraft({ subject, fromEmail: from }, config, {})) return false;
  if (normalizedSubject.includes('review queue')) return false;
  if (normalizedSubject.includes(String(config.gmail.subject || '').toLowerCase())) return false;
  if (normalizedFrom.includes('mailer-daemon') || normalizedFrom.includes('postmaster')) return false;
  if (config.gmail.cc && normalizedFrom.includes(String(config.gmail.cc).toLowerCase())) return false;
  if (!/eduard|anhaenger-eduard|anh[aä]nger|konfigurator/i.test(`${subject}\n${text}`)) return false;

  const inquiry = extractInquiry({ subject, text, html: message.html || '' });
  const hasCustomer = Boolean(inquiry.kunde_email || inquiry.kunde_vorname || inquiry.kunde_nachname);
  const hasLineItems = Array.isArray(inquiry.line_items) && inquiry.line_items.length > 0;
  const hasConfigurator = /anhaenger-eduard\.[a-z]+\/configurator|configurator\/[a-z0-9-]{12,}/i.test(text);
  return hasCustomer && (hasLineItems || hasConfigurator);
}

function htmlToText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    if (!current.startsWith('--')) continue;
    const next = rawArgs[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[current.slice(2)] = true;
    } else {
      parsed[current.slice(2)] = next;
      index += 1;
    }
  }
  return parsed;
}
