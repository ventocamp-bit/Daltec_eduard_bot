import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import {
  createMicrosoftAuthorizationUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftProfile
} from './core/microsoft-oauth.js';
import { tenantContext } from './tenant-context.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
];

export async function getMailConnectionStatus(config, context = {}) {
  const paths = getPaths(context);
  const connections = await loadMailConnections(paths);
  return {
    gmail: {
      connected: Boolean(connections.gmail?.token?.refresh_token || connections.gmail?.token?.access_token),
      configured: await fileExists(config.google.oauthClientPath),
      email: connections.gmail?.profile?.email || null,
      connectedAt: connections.gmail?.connectedAt || null,
      connectUrl: '/api/oauth/google/start'
    },
    outlook: {
      connected: Boolean(connections.outlook?.token?.refresh_token || connections.outlook?.token?.access_token),
      configured: Boolean(config.microsoft.clientId && config.microsoft.clientSecret),
      email: connections.outlook?.profile?.email || null,
      connectedAt: connections.outlook?.connectedAt || null,
      connectUrl: '/api/oauth/microsoft/start'
    }
  };
}

export async function createGoogleConnectUrl(config, context = {}, stateSecret = '') {
  if (!await fileExists(config.google.oauthClientPath)) {
    const error = new Error('google_oauth_not_configured');
    error.statusCode = 400;
    throw error;
  }
  const clientConfig = await readJson(config.google.oauthClientPath);
  const source = clientConfig.installed || clientConfig.web || clientConfig;
  const redirectUri = `${config.app.baseUrl}/api/oauth/google/callback`;
  const auth = new google.auth.OAuth2(source.client_id, source.client_secret, redirectUri);
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state: signState({ provider: 'gmail', tenantId: getPaths(context).tenantId }, stateSecret)
  });
}

export async function completeGoogleConnect(config, code, state, stateSecret = '') {
  const parsed = verifyState(state, stateSecret, 'gmail');
  const paths = getPaths({ tenantId: parsed.tenantId });
  const clientConfig = await readJson(config.google.oauthClientPath);
  const source = clientConfig.installed || clientConfig.web || clientConfig;
  const redirectUri = `${config.app.baseUrl}/api/oauth/google/callback`;
  const auth = new google.auth.OAuth2(source.client_id, source.client_secret, redirectUri);
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' }).then((res) => ({ email: res.data.emailAddress || null })).catch(() => ({}));
  await saveMailConnection(paths, 'gmail', { token: tokens, profile });
  return { tenantId: parsed.tenantId, profile };
}

export function createMicrosoftConnectUrl(config, context = {}, stateSecret = '') {
  return createMicrosoftAuthorizationUrl(
    config,
    signState({ provider: 'outlook', tenantId: getPaths(context).tenantId }, stateSecret)
  );
}

export async function completeMicrosoftConnect(config, code, state, stateSecret = '', options = {}) {
  const parsed = verifyState(state, stateSecret, 'outlook');
  const token = await (options.exchangeCode || exchangeMicrosoftCode)(config, code);
  const profile = await (options.fetchProfile || fetchMicrosoftProfile)(token);
  const tenantId = options.tenantId || parsed.tenantId;
  const paths = getPaths({ tenantId });
  await saveMailConnection(paths, 'outlook', { token, profile });
  return { tenantId, profile };
}

export async function loadMailConnections(context = {}) {
  const paths = getPaths(context);
  try {
    return JSON.parse(await fs.readFile(paths.mailConnectionsPath, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveMailConnection(context = {}, provider, connection) {
  const paths = getPaths(context);
  await fs.mkdir(paths.baseDir, { recursive: true });
  const existing = await loadMailConnections(paths);
  const next = {
    ...existing,
    [provider]: {
      ...connection,
      connectedAt: new Date().toISOString()
    }
  };
  await fs.writeFile(paths.mailConnectionsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next[provider];
}

function signState(payload, secret) {
  const state = {
    ...payload,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + 10 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret || 'dev-secret')).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyState(state, secret, provider) {
  const [encoded, sig] = String(state || '').split('.');
  const expected = crypto.createHmac('sha256', String(secret || 'dev-secret')).update(encoded || '').digest('base64url');
  if (!encoded || !sig || sig !== expected) throw new Error('invalid_oauth_state');
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (parsed.provider !== provider) throw new Error('invalid_oauth_provider');
  if (Number(parsed.expiresAt || 0) < Date.now()) throw new Error('expired_oauth_state');
  return parsed;
}

function getPaths(context = {}) {
  if (context.mailConnectionsPath && context.baseDir) return context;
  return tenantContext(context);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
