import crypto from 'node:crypto';

const SESSION_COOKIE = 'eduard_session';
const DEFAULT_ADMIN_EMAIL = 'admin@daltec.local';
const DEFAULT_ADMIN_PASSWORD = 'admin';
const DEFAULT_TENANT_ID = 'daltec-local';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export function authConfig(env = process.env) {
  const email = env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  const secret = env.ADMIN_PASSWORD_HASH || createPasswordHash(env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
  return {
    email,
    tenantId: env.ADMIN_TENANT_ID || DEFAULT_TENANT_ID,
    secret,
    sessionSecret: env.ADMIN_SESSION_SECRET || secret,
    cookieName: SESSION_COOKIE,
    secureCookie: env.NODE_ENV === 'production'
  };
}

export function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$120000$${salt}$${hash}`;
}

export function verifyPassword(password, storedSecret) {
  if (!storedSecret) return false;
  const [kind, iterationsRaw, salt, expected] = String(storedSecret).split('$');
  if (kind !== 'pbkdf2' || !iterationsRaw || !salt || !expected) return false;
  const iterations = Number(iterationsRaw);
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual);
}

export function createSession(email, config = authConfig()) {
  const session = {
    email,
    tenantId: config.tenantId || DEFAULT_TENANT_ID,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = sign(payload, config.sessionSecret);
  const token = `${payload}.${signature}`;
  return { token, session };
}

export function getSession(token, config = authConfig()) {
  if (!token || !String(token).includes('.')) return null;
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature || sign(payload, config.sessionSecret) !== signature) return null;
  let session;
  try {
    session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (session.expiresAt < Date.now()) {
    return null;
  }
  return session;
}

export function destroySession(token) {
  return Boolean(token);
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

export function sessionCookie(token, config) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (config.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(config) {
  return `${config.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
}
