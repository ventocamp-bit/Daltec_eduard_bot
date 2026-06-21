import { loadConfig } from './config.js';
import { createMailRuntime } from './mail-runtime.js';
import { appendOfferRunEvent, updateOfferRun } from './storage.js';
import { authConfig } from './auth.js';
import { createFeedbackToken } from './feedback-token.js';

export async function deliverRunDraftToOwner(run, settings, context = {}) {
  if (!run?.draft?.html_body && !run?.draft_html) {
    await appendOfferRunEvent(run.id, {
      event_type: 'owner_delivery_skipped',
      level: 'warning',
      message: 'No draft available for owner delivery'
    }, context);
    return { delivered: false, reason: 'draft_missing' };
  }

  const config = loadConfig();
  const effectiveConfig = {
    ...config,
    gmail: {
      ...config.gmail,
      to: settings.mail?.to || config.gmail.to,
      cc: config.gmail.cc,
      subject: settings.mail?.subject || config.gmail.subject
    }
  };
  const runtime = await createMailRuntime(effectiveConfig, context);
  const to = settings.mail?.to || config.gmail.to;
  const subject = settings.mail?.subject || config.gmail.subject;
  const html = wrapOwnerDraftWithFeedback(run, run.draft?.html_body || run.draft_html, config, settings);

  await runtime.sendHtmlMail(runtime.client, {
    to,
    cc: config.gmail.cc,
    subject,
    html
  });
  await updateOfferRun(run.id, {
    status: 'sent_to_owner',
    completed_at: new Date().toISOString(),
    summary: {
      ...(run.summary || {}),
      notes: `Sent by ${runtime.provider} owner adapter to ${to}`
    }
  }, context);
  await appendOfferRunEvent(run.id, {
    event_type: 'sent_to_owner',
    level: run.status === 'needs_review' ? 'warning' : 'info',
    message: `Draft sent to owner ${to}`,
    metadata: { to, cc: config.gmail.cc, provider: runtime.provider }
  }, context);
  return { delivered: true, provider: runtime.provider, to };
}

function wrapOwnerDraftWithFeedback(run, html, config, settings) {
  const baseUrl = String(config.app?.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) return html;
  const secret = authConfig().sessionSecret;
  const tenantId = run.dealer_id || settings.dealer?.id || 'daltec-local';
  const links = [
    ['sendable', 'Sendbar'],
    ['minor_correction', 'Kleine Korrektur nötig'],
    ['wrong', 'Falsch']
  ].map(([rating, label]) => {
    const token = createFeedbackToken({ tenantId, runId: run.id, rating }, secret);
    const href = `${baseUrl}/feedback?token=${encodeURIComponent(token)}`;
    return `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 12px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;background:${rating === 'wrong' ? '#b42318' : rating === 'minor_correction' ? '#ffffff' : '#111827'};color:${rating === 'minor_correction' ? '#111827' : '#ffffff'};border:1px solid #d4dae3;">${escapeHtml(label)}</a>`;
  }).join('');
  const errorText = run.error_code
    ? `<p style="margin:0 0 10px 0;color:#92400e;font-family:Arial,sans-serif;font-size:13px;"><strong>Review-Grund:</strong> ${escapeHtml(run.error_code)} ${escapeHtml(run.error_message || '')}</p>`
    : '';
  return `
    <div style="border:1px solid #d4dae3;border-radius:8px;padding:12px;margin:0 0 16px 0;background:#f8fafc;">
      <p style="margin:0 0 10px 0;color:#111827;font-family:Arial,sans-serif;font-size:14px;"><strong>Entwurf bewerten</strong></p>
      ${errorText}
      ${links}
    </div>
    ${html}
  `;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
