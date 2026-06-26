export {
  appendOfferRecord,
  appendOfferRunEvent,
  claimOfferRunForCustomerSend,
  createOfferRun,
  ensurePostgresSchema,
  ingestInboundMessage,
  isActiveRunStatus,
  listOfferRecords,
  listOfferRuns,
  loadOfferRun,
  loadTenant,
  saveGeneratedDraft,
  saveTenant,
  updateOfferRun
} from './postgres-storage.js';

export function getOnboardingChecklist(tenant, settings, dataStatus = {}) {
  return [
    {
      id: 'company',
      label: 'Firma und Signatur',
      done: Boolean(settings.signature?.company && settings.signature?.name && settings.signature?.email)
    },
    {
      id: 'pricing',
      label: 'Preislogik',
      done: Number.isFinite(Number(settings.pricing?.offerFactor)) && Number.isFinite(Number(settings.pricing?.vatRate))
    },
    {
      id: 'recipient',
      label: 'Interner Empfänger',
      done: Boolean(settings.mail?.to && settings.mail?.subject)
    },
    {
      id: 'inventory',
      label: 'Lager-/Preisdaten',
      done: dataStatus.lagerCsvExists === true || tenant.onboarding?.inventoryConnected === true
    },
    {
      id: 'google',
      label: 'Google Zugriff',
      done: tenant.onboarding?.googleConnected === true
    }
  ];
}
