import { loadConfig } from './config.js';
import { authConfig } from './auth.js';
import { loadSettings } from './settings.js';
import { createMailRuntime } from './mail-runtime.js';
import { createFeedbackToken } from './feedback-token.js';
import {
  appendOfferRunEvent,
  listOfferRuns,
  loadOfferRun
} from './storage.js';
import { isInternalOwnerDraft } from './internal-mail.js';

export async function buildReviewQueue(context) {
  const config = loadConfig();
  const settings = await loadSettings(context);
  const runs = await listOfferRuns(250, context);
  const details = await Promise.all(runs.map((run) => loadOfferRun(run.id, context)));
  const items = details
    .filter(Boolean)
    .filter((run) => !isMonitoringNoise(run, config, settings))
    .filter((run) => ['completed', 'sent_to_owner', 'needs_review'].includes(run.status))
    .filter((run) => run.draft || run.draft_html)
    .filter((run) => !(run.owner_feedback || run.summary?.ownerFeedback))
    .map(reviewQueueItem)
    .sort((a, b) => b.priority - a.priority || String(b.created_at).localeCompare(String(a.created_at)));

  const feedbackCount = details
    .filter(Boolean)
    .filter((run) => !isMonitoringNoise(run, config, settings))
    .filter((run) => run.owner_feedback || run.summary?.ownerFeedback)
    .length;

  return {
    generatedAt: new Date().toISOString(),
    tenantId: context.tenantId,
    openCount: items.length,
    feedbackCount,
    targetFeedbackCount: 20,
    items,
    latestDigestSentAt: latestReviewDigestSentAt(details)
  };
}

export async function sendReviewQueueDigest(context, options = {}) {
  const settings = await loadSettings(context);
  const config = loadConfig();
  const queue = await buildReviewQueue(context);
  const items = queue.items.slice(0, Math.max(1, Number(options.limit || 20)));
  const to = settings.mail?.to || config.gmail.to;
  const cc = config.gmail.cc;
  const subject = `Eduard Review Queue: ${items.length} offene Bewertungen`;
  const html = reviewDigestHtml(items, { config, context, auth: options.auth || authConfig() });

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
      metadata: { to, cc, subject, reminder: Boolean(options.reminder) }
    }, context)));
    return { delivered: true, dryRun: false, provider: runtime.provider, to, cc, subject, count: items.length };
  }

  return { delivered: false, dryRun: true, to, cc, subject, count: items.length, html };
}

export async function sendReviewReminderIfDue(context, options = {}) {
  if (process.env.REVIEW_DIGEST_AUTO !== 'true' && options.force !== true) {
    return { delivered: false, reason: 'disabled' };
  }
  const cooldownHours = Number(process.env.REVIEW_DIGEST_COOLDOWN_HOURS || options.cooldownHours || 20);
  const minOpen = Number(process.env.REVIEW_DIGEST_MIN_OPEN || options.minOpen || 1);
  const queue = await buildReviewQueue(context);
  if (queue.openCount < minOpen) {
    return { delivered: false, reason: 'empty_or_below_minimum', openCount: queue.openCount };
  }
  if (queue.latestDigestSentAt) {
    const ageHours = (Date.now() - new Date(queue.latestDigestSentAt).getTime()) / 36e5;
    if (ageHours < cooldownHours) {
      return {
        delivered: false,
        reason: 'cooldown',
        openCount: queue.openCount,
        latestDigestSentAt: queue.latestDigestSentAt,
        cooldownHours,
        ageHours: Number(ageHours.toFixed(2))
      };
    }
  }
  return sendReviewQueueDigest(context, { limit: options.limit || 20, reminder: true });
}

function latestReviewDigestSentAt(runs) {
  return runs
    .flatMap((run) => run?.events || [])
    .filter((event) => event.event_type === 'review_digest_sent')
    .map((event) => event.created_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
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
    nextAction: isNeedsReview ? 'Prüfen und Feedback setzen' : 'Sendbarkeit bestätigen'
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

function isMonitoringNoise(run, config, settings) {
  const inbound = run.inbound_message || {};
  const provider = String(inbound.provider || '').toLowerCase();
  const from = String(inbound.from_email || '').toLowerCase();
  const subject = String(inbound.subject || '').toLowerCase();
  if (isInternalOwnerDraft({ subject: inbound.subject, fromEmail: inbound.from_email }, config, settings)) return true;
  if (provider.includes('test') || provider.includes('debug') || provider.includes('loop')) return true;
  if (from.endsWith('@example.com') || from.includes('@dealer.example')) return true;
  if (subject.includes('p0 test') || subject.includes('debug test') || subject.includes('saas ready')) return true;
  return false;
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
