export function loadConfig(env = process.env) {
  return {
    app: {
      baseUrl: env.APP_BASE_URL || `http://localhost:${env.ADMIN_PORT || 3030}`
    },
    gmail: {
      senderQuery: env.GMAIL_SENDER_QUERY || 'office',
      subjectFilter: env.GMAIL_SUBJECT_FILTER || 'Eduard',
      pollMinutes: Number(env.GMAIL_POLL_MINUTES || 5),
      to: env.MAIL_TO || 'michael@daltec.at',
      cc: 'ventocamp@gmail.com',
      subject: env.MAIL_SUBJECT || 'Daltec Eduard Angebot'
    },
    google: {
      oauthClientPath: env.GOOGLE_OAUTH_CLIENT_PATH || './secrets/google-oauth-client.json',
      oauthTokenPath: env.GOOGLE_OAUTH_TOKEN_PATH || './secrets/google-oauth-token.json'
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID || '',
      clientSecret: env.MICROSOFT_CLIENT_SECRET || '',
      redirectUri: env.MICROSOFT_REDIRECT_URI || '',
      tenant: env.MICROSOFT_TENANT || 'common'
    }
  };
}
