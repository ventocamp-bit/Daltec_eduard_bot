import imaps from 'imap-simple';

const DEFAULT_IMAP = {
  host: 'imap.outlook.com',
  port: 993,
  tls: true
};

export function redactImapSettings(imap = {}) {
  const redacted = { ...imap };
  if ('app_password' in redacted) redacted.app_password = '***';
  if ('password' in redacted) redacted.password = '***';
  return redacted;
}

export async function testImapConnection(imap = {}, options = {}) {
  const connect = options.connect || imaps.connect;
  let connection;
  try {
    connection = await connect(buildImapConfig(imap));
    await connection.openBox?.('INBOX');
    return true;
  } catch (error) {
    if (isAuthFailure(error)) {
      const authError = new Error('imap_auth_failed');
      authError.statusCode = 401;
      throw authError;
    }
    throw error;
  } finally {
    connection?.end?.();
  }
}

export async function fetchUnseenImapMessages(imap = {}, options = {}) {
  const connect = options.connect || imaps.connect;
  let connection;
  try {
    connection = await connect(buildImapConfig(imap));
    await connection.openBox('INBOX');
    const messages = await connection.search(['UNSEEN'], {
      bodies: ['HEADER', 'TEXT'],
      markSeen: true
    });
    return (messages || []).map(normalizeImapMessage);
  } finally {
    connection?.end?.();
  }
}

export function createImapPoller(options = {}) {
  const tenantId = options.tenantId || 'daltec-local';
  const intervalMs = Number(options.intervalMs || 5 * 60 * 1000);
  const onMessage = options.onMessage || (async () => null);
  const connect = options.connect || imaps.connect;
  const logger = options.logger || console;
  let timer = null;

  async function pollOnce() {
    const messages = await fetchUnseenImapMessages(options.imap, { connect });
    for (const message of messages) {
      await onMessage(message, { tenantId });
    }
    return { tenantId, count: messages.length };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      pollOnce().catch((error) => logger.error?.(`[imap:${tenantId}] ${sanitizeLogMessage(error.message)}`));
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    tenantId,
    start,
    stop,
    pollOnce,
    isRunning: () => Boolean(timer)
  };
}

export function createImapPollerRegistry(options = {}) {
  const pollers = new Map();
  const loadSettings = options.loadSettings;
  const tenantContext = options.tenantContext || ((tenantId) => ({ tenantId }));
  const onMessage = options.onMessage || (async () => null);
  const connect = options.connect || imaps.connect;
  const logger = options.logger || console;
  const intervalMs = Number(options.intervalMs || 5 * 60 * 1000);

  async function startTenant(tenantId) {
    stopTenant(tenantId);
    const context = tenantContext(tenantId);
    const settings = await loadSettings(context);
    if (!settings.imap?.email || !settings.imap?.app_password) return null;
    const poller = createImapPoller({
      tenantId,
      imap: settings.imap,
      intervalMs,
      connect,
      logger,
      onMessage: async (message) => onMessage(message, context)
    });
    poller.start();
    pollers.set(tenantId, poller);
    return poller;
  }

  function stopTenant(tenantId) {
    const existing = pollers.get(tenantId);
    if (existing) existing.stop();
    pollers.delete(tenantId);
  }

  return {
    startTenant,
    stopTenant,
    isActive: (tenantId) => pollers.get(tenantId)?.isRunning() === true,
    pollOnce: (tenantId) => pollers.get(tenantId)?.pollOnce() || Promise.resolve({ tenantId, count: 0 })
  };
}

function buildImapConfig(imap = {}) {
  return {
    imap: {
      user: String(imap.email || ''),
      password: String(imap.app_password || ''),
      host: imap.host || DEFAULT_IMAP.host,
      port: Number(imap.port || DEFAULT_IMAP.port),
      tls: imap.tls !== false,
      authTimeout: 10_000
    }
  };
}

function normalizeImapMessage(message = {}) {
  const header = partBody(message, 'HEADER') || {};
  const text = String(partBody(message, 'TEXT') || '');
  const uid = message.attributes?.uid || message.attributes?.messageId || cryptoSafeId(header, text);
  return {
    id: `imap-${uid}`,
    subject: firstHeader(header.subject),
    from: emailAddress(firstHeader(header.from)),
    to: emailAddress(firstHeader(header.to)),
    received_at: normalizeDate(firstHeader(header.date) || message.attributes?.date),
    html: looksLikeHtml(text) ? text : '',
    text: looksLikeHtml(text) ? stripHtml(text) : text,
    attachments: []
  };
}

function emailAddress(value) {
  const text = String(value || '');
  return text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[1] || text;
}

function partBody(message, which) {
  const part = (message.parts || []).find((entry) => String(entry.which || '').toUpperCase() === which);
  return part?.body;
}

function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function normalizeDate(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function cryptoSafeId(header, text) {
  const basis = `${firstHeader(header.messageId || header['message-id'])}:${firstHeader(header.subject)}:${text.length}`;
  let hash = 0;
  for (let index = 0; index < basis.length; index += 1) {
    hash = ((hash << 5) - hash) + basis.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function isAuthFailure(error) {
  return /auth|login|credential|password|invalid/i.test(String(error?.source || error?.code || error?.message || ''));
}

function sanitizeLogMessage(message) {
  return String(message || '').replace(/password=[^\s]+/gi, 'password=***');
}
