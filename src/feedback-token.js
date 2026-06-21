import crypto from 'node:crypto';

const FEEDBACK_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function createFeedbackToken({ tenantId, runId, rating }, secret) {
  const payload = {
    tenantId,
    runId,
    rating,
    expiresAt: Date.now() + FEEDBACK_TTL_MS
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyFeedbackToken(token, secret) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature || sign(encoded, secret) !== signature) {
    const error = new Error('invalid_feedback_token');
    error.statusCode = 400;
    throw error;
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (Number(payload.expiresAt || 0) < Date.now()) {
    const error = new Error('expired_feedback_token');
    error.statusCode = 400;
    throw error;
  }
  return payload;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', String(secret || 'dev-secret')).update(payload).digest('base64url');
}
