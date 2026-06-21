import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { exportGmailMessages } from './export-mails.js';

dotenv.config();

const DEFAULT_QUERIES = [
  'Eduard',
  '"EDUARD-Konfigurator"',
  '"Neuer Lead"',
  '"Angebot via EDUARD-Konfigurator"',
  'anhaenger-eduard',
  'configurator',
  '"Konfiguration anschauen"',
  'from:office@daltec.at',
  'from:office subject:Lead',
  'from:office konfigurator',
  'from:office Eduard'
];

const args = parseArgs(process.argv.slice(2));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/export-proof-corpus.js')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export async function exportProofCorpus(options = {}) {
  const perQueryLimit = Number(options.perQueryLimit || 500);
  const queries = options.queries || DEFAULT_QUERIES;
  const seen = new Set();
  const messages = [];
  const queryReports = [];

  for (const query of queries) {
    const report = await exportGmailMessages({
      tenantId: options.tenantId,
      query,
      limit: perQueryLimit,
      proofOnly: true
    });
    let added = 0;
    for (const message of report.messages) {
      const key = message.providerMessageId || `${message.subject}:${message.fromEmail}:${message.receivedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
      added += 1;
    }
    queryReports.push({
      query,
      count: report.count,
      added
    });
  }

  messages.sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));

  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
  }

  return {
    generatedAt: new Date().toISOString(),
    queryCount: queries.length,
    count: messages.length,
    out: options.out || null,
    queries: queryReports,
    sample: messages.slice(0, 5).map((message) => ({
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      fromEmail: message.fromEmail,
      receivedAt: message.receivedAt
    }))
  };
}

async function main() {
  const out = args.out || `data/replay-exports/gmail-proof-corpus-${Date.now()}.json`;
  const report = await exportProofCorpus({
    tenantId: args.tenant,
    perQueryLimit: args['per-query-limit'] || args.limit || 500,
    out
  });
  console.log(JSON.stringify(report, null, 2));
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
