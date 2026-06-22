import fs from 'node:fs/promises';
import { google } from 'googleapis';
import { loadMailConnections } from '../mail-connections.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
];

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

export async function createGoogleClients(config, context = {}) {
  const clientConfig = await readJson(config.google.oauthClientPath);
  const connections = await loadMailConnections(context);
  const token = connections.gmail?.token || await readJson(config.google.oauthTokenPath);
  const source = clientConfig.installed || clientConfig.web || clientConfig;

  const auth = new google.auth.OAuth2(
    source.client_id,
    source.client_secret,
    Array.isArray(source.redirect_uris) ? source.redirect_uris[0] : source.redirect_uri
  );
  auth.setCredentials(token);

  return {
    auth,
    gmail: google.gmail({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth })
  };
}

export function getGoogleAuthUrl(clientConfig) {
  const source = clientConfig.installed || clientConfig.web || clientConfig;
  const auth = new google.auth.OAuth2(
    source.client_id,
    source.client_secret,
    Array.isArray(source.redirect_uris) ? source.redirect_uris[0] : source.redirect_uri
  );
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
}

export async function fetchUnreadMessages(gmail, config) {
  const q = buildUnreadQuery(config);
  const result = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 10
  });
  const messages = result.data.messages || [];
  const hydrated = [];

  for (const message of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full'
    });
    hydrated.push(await parseGmailMessage(detail.data, gmail));
  }

  return hydrated;
}

export function buildUnreadQuery(config) {
  if (config.gmail.query) return config.gmail.query;
  const parts = ['is:unread'];
  if (config.gmail.senderQuery) parts.push(`from:${config.gmail.senderQuery}`);
  if (config.gmail.subjectFilter) parts.push(`subject:${config.gmail.subjectFilter}`);
  if (config.gmail.subject) parts.push(`-subject:"${config.gmail.subject}"`);
  if (config.gmail.cc) parts.push(`-from:${config.gmail.cc}`);
  return parts.join(' ');
}

export async function searchMessages(gmail, query, maxResults = 20) {
  const messages = [];
  let pageToken;
  while (messages.length < maxResults) {
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(500, maxResults - messages.length),
      pageToken
    });
    messages.push(...(result.data.messages || []));
    pageToken = result.data.nextPageToken;
    if (!pageToken) break;
  }
  const hydrated = [];

  for (const message of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full'
    });
    hydrated.push(await parseGmailMessage(detail.data, gmail));
  }

  return hydrated;
}

export async function markMessageRead(gmail, id) {
  await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: {
      removeLabelIds: ['UNREAD']
    }
  });
}

export async function labelMessage(gmail, id, labelName) {
  const labelId = await ensureLabel(gmail, labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: {
      addLabelIds: [labelId]
    }
  });
}

async function ensureLabel(gmail, name) {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const label = (existing.data.labels || []).find((entry) => entry.name === name);
  if (label?.id) return label.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }
  });
  return created.data.id;
}

export async function sendHtmlMail(gmail, { to, cc, subject, html }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html
  ].filter(Boolean);

  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
}

export async function readSheetObjects(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = response.data.values || [];
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

async function parseGmailMessage(message, gmail) {
  const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
  const parts = flattenParts(message.payload);
  const htmlPart = parts.find((part) => part.mimeType === 'text/html');
  const textPart = parts.find((part) => part.mimeType === 'text/plain');
  const attachmentParts = parts.filter((part) => part.filename && (part.body?.attachmentId || part.body?.data));
  const attachments = [];
  for (const part of attachmentParts) {
    const data = part.body?.data || await fetchAttachmentData(gmail, message.id, part.body?.attachmentId);
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType || '',
      size: part.body?.size || 0,
      data: decodeBuffer(data)
    });
  }

  return {
    id: message.id,
    subject: headers.subject || '',
    from: headers.from || '',
    to: headers.to || '',
    html: decodeBody(htmlPart?.body?.data),
    text: decodeBody(textPart?.body?.data) || message.snippet || '',
    attachments
  };
}

function flattenParts(part) {
  if (!part) return [];
  return [part, ...(part.parts || []).flatMap(flattenParts)];
}

function decodeBody(data) {
  if (!data) return '';
  return decodeBuffer(data).toString('utf8');
}

function decodeBuffer(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function fetchAttachmentData(gmail, messageId, attachmentId) {
  if (!attachmentId) return '';
  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId
  });
  return response.data.data || '';
}
