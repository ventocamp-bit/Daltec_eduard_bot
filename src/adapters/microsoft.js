import { loadMailConnections, saveMailConnection } from '../mail-connections.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export async function createMicrosoftMailClient(config, context = {}) {
  const connections = await loadMailConnections(context);
  const connection = connections.outlook;
  if (!connection?.token?.access_token) {
    const error = new Error('outlook_not_connected');
    error.statusCode = 400;
    throw error;
  }

  const token = await refreshMicrosoftTokenIfNeeded(config, context, connection);
  return {
    provider: 'outlook',
    accessToken: token.access_token
  };
}

export async function fetchUnreadMessages(client, config) {
  const url = new URL(`${GRAPH_BASE}/me/messages`);
  url.searchParams.set('$top', '10');
  url.searchParams.set('$filter', 'isRead eq false');
  url.searchParams.set('$select', 'id,subject,from,toRecipients,receivedDateTime,body,bodyPreview,hasAttachments');
  url.searchParams.set('$orderby', 'receivedDateTime desc');

  const data = await graphRequest(client, url.toString());
  const senderQuery = String(config.gmail?.senderQuery || '').toLowerCase();

  const messages = (data.value || [])
    .filter((message) => {
      if (!senderQuery) return true;
      const from = [
        message.from?.emailAddress?.address || '',
        message.from?.emailAddress?.name || ''
      ].join(' ').toLowerCase();
      return from.includes(senderQuery);
    })
    .map((message) => ({
      id: message.id,
      subject: message.subject || '',
      from: message.from?.emailAddress?.address || message.from?.emailAddress?.name || '',
      to: (message.toRecipients || []).map((recipient) => recipient.emailAddress?.address || recipient.emailAddress?.name || '').filter(Boolean).join(', '),
      received_at: message.receivedDateTime || new Date().toISOString(),
      html: message.body?.contentType === 'html' ? message.body.content || '' : '',
      text: message.body?.contentType === 'text' ? message.body.content || '' : message.bodyPreview || '',
      hasAttachments: message.hasAttachments === true
    }));
  for (const message of messages) {
    message.attachments = message.hasAttachments ? await fetchMessageAttachments(client, message.id) : [];
  }
  return messages;
}

export async function markMessageRead(client, id) {
  await graphRequest(client, `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true })
  });
}

export async function sendHtmlMail(client, { to, cc, subject, html }) {
  await graphRequest(client, `${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: 'HTML',
          content: html
        },
        toRecipients: toRecipientList(to),
        ccRecipients: toRecipientList(cc)
      },
      saveToSentItems: true
    })
  });
}

async function refreshMicrosoftTokenIfNeeded(config, context, connection) {
  const token = connection.token;
  if (!token.refresh_token || Number(token.expiresAt || 0) > Date.now() + 60_000) {
    return token;
  }

  const body = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    scope: [
      'offline_access',
      'User.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send'
    ].join(' ')
  });

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = new Error(`microsoft_refresh_failed: ${await response.text()}`);
    error.statusCode = 400;
    throw error;
  }

  const refreshed = await response.json();
  refreshed.expiresAt = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
  const nextToken = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token
  };
  await saveMailConnection(context, 'outlook', {
    token: nextToken,
    profile: connection.profile || {}
  });
  return nextToken;
}

async function graphRequest(client, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${client.accessToken}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`microsoft_graph_failed: ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

function toRecipientList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((address) => ({
      emailAddress: { address }
    }));
}

async function fetchMessageAttachments(client, messageId) {
  const url = new URL(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments`);
  url.searchParams.set('$select', 'name,contentType,size,contentBytes');
  const data = await graphRequest(client, url.toString());
  return (data.value || [])
    .filter((attachment) => attachment.contentBytes)
    .map((attachment) => ({
      filename: attachment.name || '',
      mimeType: attachment.contentType || '',
      size: attachment.size || 0,
      data: Buffer.from(attachment.contentBytes, 'base64')
    }));
}
