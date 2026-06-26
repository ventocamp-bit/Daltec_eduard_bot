import { getMailConnectionStatus } from './mail-connections.js';
import { fileExists } from './adapters/local-data.js';

export async function createMailRuntime(config, context = {}, options = {}) {
  const status = await getMailConnectionStatus(config, context);
  const allowLegacyGoogleToken = options.allowLegacyGoogleToken !== false;
  const hasLegacyGoogleToken = allowLegacyGoogleToken && await fileExists(config.google.oauthTokenPath);

  if (status.gmail.connected || hasLegacyGoogleToken) {
    const googleAdapter = await import('./adapters/google.js');
    const { gmail } = await googleAdapter.createGoogleClients(config, context);
    return {
      provider: 'gmail',
      client: gmail,
      fetchUnreadMessages: googleAdapter.fetchUnreadMessages,
      markMessageRead: googleAdapter.markMessageRead,
      sendHtmlMail: async (...args) => {
        console.warn('MAIL SENDING DISABLED BY USER REQUEST. Would have sent via GMAIL:', args[1]?.subject);
        return { id: 'disabled_by_user' };
      },
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
      sendHtmlMail: async (...args) => {
        console.warn('MAIL SENDING DISABLED BY USER REQUEST. Would have sent via OUTLOOK:', args[1]?.subject);
        return { id: 'disabled_by_user' };
      },
      labelMessage: async () => null
    };
  }

  throw new Error('Kein Mail-Zugang verbunden. In der Admin-Website Gmail oder Outlook verbinden.');
}
