import { extractInquiry } from './core/parser.js';
import { calculateInquiryOffer } from './core/pricing.js';
import { matchInventory } from './core/inventory.js';
import { buildOfferEmail } from './core/email-template.js';
import { appendOfferRecord, loadTenant, saveTenant } from './storage.js';

export function isEduardInquiry(message, subjectFilter = 'Eduard') {
  const subject = message.subject || message.Subject || '';
  return subject.toLowerCase().includes(subjectFilter.toLowerCase());
}

export function runWorkflow(message, dependencies = {}) {
  const preisliste = dependencies.preisliste || [];
  const lagerBestand = dependencies.lagerBestand || [];
  const settings = dependencies.settings || {};

  const inquiry = extractInquiry(message);
  const priced = calculateInquiryOffer(inquiry, preisliste, settings);
  const matched = matchInventory(priced, lagerBestand, preisliste, settings);
  const offer = buildOfferEmail(matched, settings);

  return {
    inquiry,
    priced,
    matched,
    offer
  };
}

export async function runWorkflowAndRecord(message, dependencies = {}) {
  const tenantContext = dependencies.tenantContext || {};
  const result = runWorkflow(message, dependencies);
  const record = await appendOfferRecord(result, {
    messageId: message.id || null,
    subject: message.subject || message.Subject || null,
    mode: dependencies.mode || 'workflow'
  }, tenantContext);
  const tenant = await loadTenant(tenantContext);
  await saveTenant({
    ...tenant,
    onboarding: {
      ...tenant.onboarding,
      firstOfferCreated: true
    }
  }, tenantContext);
  return { ...result, record };
}
