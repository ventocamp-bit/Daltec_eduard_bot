import { getMailConnectionStatus } from './mail-connections.js';
import { fileExists } from './adapters/local-data.js';

export async function createMailRuntime(config, context = {}, options = {}) {
  const status = await getMailConnectionStatus(config, context);
  const allowLegacyGoogleToken = options.allowLegacyGoogleToken !== false;
  const hasLegacyGoogleToken = allowLegacyGoogleToken && await fileExists(config.google.oauthTokenPath);
  const sendMode = process.env.MAIL_SEND_MODE || 'disabled';

  if (status.gmail.connected || hasLegacyGoogleToken) {
    const googleAdapter = await import('./adapters/google.js');
    const { gmail } = await googleAdapter.createGoogleClients(config, context);
    return {
      provider: 'gmail',
      client: gmail,
      fetchUnreadMessages: googleAdapter.fetchUnreadMessages,
      markMessageRead: googleAdapter.markMessageRead,
      sendHtmlMail: sendMode === 'enabled'
        ? googleAdapter.sendHtmlMail
        : disabledSender('gmail'),
      labelMessage: googleAdapter.labelMessage
    };
  }

  if (status.outlook.connected) {
    const microsoftAdapter = await import('./adapters/microsoft.js');
    return {
      provider: 'outlook',
      client: await microsoftAdapter.createMicrosoftMailClient(config, context),
      fetchUnreadMessages: microsoftAdapter.fetchUnreadMessages,
      markMessageRead: microsoftAdapter.markMessageRead,
      sendHtmlMail: sendMode === 'enabled'
        ? microsoftAdapter.sendHtmlMail
        : disabledSender('outlook'),
      labelMessage: async () => null
    };
  }

  throw new Error('Kein Mail-Zugang verbunden. In der Admin-Website Gmail oder Outlook verbinden.');
}

function disabledSender(provider) {
  return async () => {
    const error = new Error(`mail_send_disabled:${provider}`);
    error.statusCode = 409;
    throw error;
  };
}
