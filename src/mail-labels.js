const REVIEW_ERROR_CODES = new Set([
  'no_inventory_match',
  'weak_inventory_match',
  'inventory_stale',
  'no_valid_items',
  'negative_discount'
]);

export function labelForProcessedRun(preDeliveryStatus, run = {}) {
  if (String(run.status || '').startsWith('failed') || String(preDeliveryStatus || '').startsWith('failed')) {
    return 'Eduard/failed';
  }
  if (
    preDeliveryStatus === 'needs_review' ||
    run.status === 'needs_review' ||
    REVIEW_ERROR_CODES.has(run.error_code) ||
    (run.events || []).some((event) => event.event_type === 'run_needs_review' || event.event_type === 'price_needs_review')
  ) {
    return 'Eduard/needs_review';
  }
  return 'Eduard/processed';
}

export function labelForIgnoredRun(reason = '') {
  if (reason === 'duplicate') return 'Eduard/duplicate';
  if (reason === 'internal') return 'Eduard/ignored-internal';
  return 'Eduard/ignored';
}
