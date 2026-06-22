import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImapPoller,
  fetchUnseenImapMessages,
  redactImapSettings,
  resolveImapHost,
  testImapConnection
} from '../src/core/imap-poller.js';

test('imap-poller starts and stops cleanly', () => {
  const poller = createImapPoller({
    tenantId: 'tenant-a',
    imap: { email: 'inbox@example.at', app_password: 'secret' },
    intervalMs: 60_000,
    onMessage: async () => null,
    connect: async () => fakeImapConnection([])
  });

  assert.equal(poller.isRunning(), false);
  poller.start();
  assert.equal(poller.isRunning(), true);
  poller.stop();
  assert.equal(poller.isRunning(), false);
});

test('imap connect maps authentication failures to 401 without logging password', async () => {
  const logs = [];
  const credentials = { email: 'inbox@example.at', app_password: 'top-secret-app-password' };
  await assert.rejects(
    () => testImapConnection(credentials, {
      connect: async () => {
        const error = new Error('AUTHENTICATIONFAILED for top-secret-app-password');
        error.source = 'authentication';
        throw error;
      },
      logger: { error: (message) => logs.push(String(message)) }
    }),
    (error) => error.statusCode === 401 && error.message === 'imap_auth_failed'
  );

  assert.equal(logs.some((line) => line.includes('top-secret-app-password')), false);
  assert.equal(JSON.stringify(redactImapSettings(credentials)).includes('top-secret-app-password'), false);
});

test('imap-poller feeds normalized unseen mail into pipeline handler', async () => {
  const delivered = [];
  const poller = createImapPoller({
    tenantId: 'tenant-a',
    imap: { email: 'inbox@example.at', app_password: 'secret' },
    intervalMs: 60_000,
    onMessage: async (message) => delivered.push(message),
    connect: async () => fakeImapConnection([fakeImapMessage()])
  });

  const result = await poller.pollOnce();
  assert.equal(result.count, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, 'imap-42');
  assert.equal(delivered[0].from, 'kunde@example.com');
  assert.equal(delivered[0].to, 'anfragen@example.at');
  assert.equal(delivered[0].subject, 'Eduard Anfrage');
  assert.match(delivered[0].text, /Hochlader 3318/);
  assert.equal(delivered[0].received_at, '2026-06-22T09:00:00.000Z');
});

test('fetchUnseenImapMessages reads only UNSEEN and marks messages seen', async () => {
  const calls = [];
  const messages = await fetchUnseenImapMessages(
    { email: 'inbox@example.at', app_password: 'secret' },
    {
      connect: async (config) => fakeImapConnection([fakeImapMessage()], calls, config)
    }
  );

  assert.equal(messages.length, 1);
  assert.deepEqual(calls.find((call) => call.type === 'search').criteria, ['UNSEEN']);
  assert.equal(calls.find((call) => call.type === 'search').options.markSeen, true);
  assert.equal(calls.find((call) => call.type === 'connect').config.imap.host, 'imap.example.at');
  assert.equal(calls.find((call) => call.type === 'connect').config.imap.port, 993);
  assert.equal(calls.find((call) => call.type === 'connect').config.imap.tls, true);
});

test('imap host is resolved from email domain with known providers and fallback', () => {
  assert.equal(resolveImapHost({ email: 'inbox@outlook.com' }), 'imap.outlook.com');
  assert.equal(resolveImapHost({ email: 'inbox@gmail.com' }), 'imap.gmail.com');
  assert.equal(resolveImapHost({ email: 'inbox@drei.at' }), 'imap.drei.at');
  assert.equal(resolveImapHost({ email: 'inbox@autohaus.at' }), 'imap.autohaus.at');
});

test('imap host from body overrides email domain autodetect', async () => {
  const calls = [];
  await fetchUnseenImapMessages(
    { email: 'inbox@gmail.com', app_password: 'secret', host: 'imap.custom.at' },
    {
      connect: async (config) => fakeImapConnection([], calls, config)
    }
  );

  assert.equal(calls.find((call) => call.type === 'connect').config.imap.host, 'imap.custom.at');
});

function fakeImapConnection(messages, calls = [], config = null) {
  if (config) calls.push({ type: 'connect', config });
  return {
    openBox: async (box) => calls.push({ type: 'openBox', box }),
    search: async (criteria, options) => {
      calls.push({ type: 'search', criteria, options });
      return messages;
    },
    end: () => calls.push({ type: 'end' })
  };
}

function fakeImapMessage() {
  return {
    attributes: {
      uid: 42,
      date: new Date('2026-06-22T09:00:00.000Z')
    },
    parts: [
      {
        which: 'HEADER',
        body: {
          from: ['Kunde <kunde@example.com>'],
          to: ['anfragen@example.at'],
          subject: ['Eduard Anfrage'],
          date: ['Mon, 22 Jun 2026 09:00:00 +0000']
        }
      },
      {
        which: 'TEXT',
        body: 'Vorname Max\nHochlader 3318 3500kg'
      }
    ]
  };
}
