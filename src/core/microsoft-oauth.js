export const MICROSOFT_AUTHORIZATION_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MICROSOFT_SCOPES = ['Mail.Read', 'Mail.Send', 'offline_access'];

export function microsoftRedirectUri(config = {}) {
  return config.microsoft?.redirectUri || `${config.app?.baseUrl || 'http://localhost:3030'}/api/oauth/microsoft/callback`;
}

export function createMicrosoftAuthorizationUrl(config = {}, state = '') {
  const clientId = config.microsoft?.clientId || '';
  if (!clientId || !config.microsoft?.clientSecret) {
    const error = new Error('microsoft_oauth_not_configured');
    error.statusCode = 400;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: microsoftRedirectUri(config),
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state
  });
  return `${MICROSOFT_AUTHORIZATION_URL}?${params}`;
}

export async function exchangeMicrosoftCode(config = {}, code = '', fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: config.microsoft?.clientId || '',
    client_secret: config.microsoft?.clientSecret || '',
    grant_type: 'authorization_code',
    code,
    redirect_uri: microsoftRedirectUri(config),
    scope: MICROSOFT_SCOPES.join(' ')
  });
  const response = await fetchImpl(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = new Error(`microsoft_token_failed: ${await response.text()}`);
    error.statusCode = 400;
    throw error;
  }
  const token = await response.json();
  return {
    ...token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
  };
}

export async function fetchMicrosoftProfile(token = {}, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    if (!response.ok) return {};
    const data = await response.json();
    return { email: data.mail || data.userPrincipalName || null };
  } catch {
    return {};
  }
}
