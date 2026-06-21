export function isInternalOwnerDraft(message = {}, config = {}, settings = {}) {
  const subject = String(message.subject || '').toLowerCase();
  const from = String(message.from || message.fromEmail || message.from_email || '').toLowerCase();
  const configuredSubjects = [
    settings.mail?.subject,
    settings.mail?.internalSubject,
    config.gmail?.subject
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const systemMailboxes = [
    config.gmail?.cc,
    settings.onboarding?.forwardingEmail,
    'ventocamp@gmail.com'
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  return Boolean(
    configuredSubjects.some((configuredSubject) => configuredSubject && subject.includes(configuredSubject)) ||
    systemMailboxes.some((mailbox) => mailbox && from.includes(mailbox))
  );
}
