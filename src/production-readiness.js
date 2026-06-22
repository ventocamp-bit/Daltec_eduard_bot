import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_VALUES = new Set([
  '',
  'admin',
  'dev-secret',
  'change-this-long-random-secret',
  'CHANGE_ME_LONG_RANDOM_PASSWORD',
  'CHANGE_ME_LONG_RANDOM_SECRET',
  'CHANGE_ME_LONG_RANDOM_INGEST_SECRET',
  'eduard-postgres-local-change-me'
]);

export async function buildRuntimeReadiness({ env = process.env, config, settings, mailStatus } = {}) {
  const backup = await inspectBackupState(env);
  return inspectRuntimeReadiness({ env, config, settings, mailStatus, backup });
}

export function inspectRuntimeReadiness({ env = process.env, config = {}, settings = {}, mailStatus = {}, backup = {} } = {}) {
  const appBaseUrl = config.app?.baseUrl || env.APP_BASE_URL || '';
  const adminPassword = env.ADMIN_PASSWORD || '';
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH || '';
  const sessionSecret = env.ADMIN_SESSION_SECRET || '';
  const ingestSecret = env.EDUARD_INGEST_SECRET || '';
  const postgresPassword = env.POSTGRES_PASSWORD || '';
  const deliveryMode = settings.mail?.deliveryMode || 'owner_review';
  const checks = [
    check('node_env_production', env.NODE_ENV === 'production', 'NODE_ENV=production ist gesetzt.', 'NODE_ENV ist nicht production.'),
    check('https_base_url', /^https:\/\//i.test(appBaseUrl), 'APP_BASE_URL nutzt HTTPS.', 'APP_BASE_URL muss für SaaS HTTPS nutzen.'),
    check('postgres_enabled', Boolean(env.DATABASE_URL), 'Postgres ist aktiv.', 'DATABASE_URL fehlt. JSONL ist kein SaaS-Storage.'),
    check('admin_password_hashed', Boolean(adminPasswordHash), 'Admin-Passwort ist gehasht.', 'ADMIN_PASSWORD_HASH fehlt. Plain ADMIN_PASSWORD ist für SaaS nicht genug.'),
    check('admin_password_not_default', Boolean(adminPasswordHash) || isStrongSecret(adminPassword, 18), 'Admin-Passwort ist nicht trivial.', 'Admin-Passwort ist Default/zu kurz.'),
    check('session_secret_strong', isStrongSecret(sessionSecret, 32), 'Session Secret ist stark.', 'ADMIN_SESSION_SECRET fehlt, ist Default oder zu kurz.'),
    check('ingest_secret_strong', isStrongSecret(ingestSecret, 32), 'Inbound Secret ist stark.', 'EDUARD_INGEST_SECRET fehlt, ist Default oder zu kurz.'),
    check('postgres_password_strong', !postgresPassword || isStrongSecret(postgresPassword, 24), 'Postgres Passwort ist nicht Default.', 'POSTGRES_PASSWORD ist Default/zu kurz.'),
    check('backup_recent', backup.configured && backup.latestAgeHours !== null && backup.latestAgeHours <= backup.maxAgeHours, 'Postgres Backup ist aktuell.', 'Kein aktuelles Postgres Backup gefunden.'),
    check('owner_review_only', deliveryMode !== 'customer_auto', 'Kundenversand ist blockiert.', 'Direkter Kundenversand ist aktiv. Für Proof/SaaS muss Owner-Review Standard sein.'),
    check('mail_connected', Boolean(mailStatus.gmail?.connected || mailStatus.outlook?.connected), 'Mailzugang ist verbunden.', 'Kein Gmail/Outlook Zugriff verbunden.'),
    check('oauth_verified_or_forwarding', env.GOOGLE_OAUTH_VERIFIED === 'true' || env.SAAS_MAIL_MODE === 'central_forwarding', 'OAuth/Forwarding ist SaaS-tauglich markiert.', 'Google OAuth ist nicht als verifiziert markiert. Kunden sehen sonst den Warnscreen.')
  ];

  const blockers = checks
    .filter((item) => !item.ok)
    .map((item) => ({
      code: item.id,
      severity: 'p0',
      message: item.fail
    }));

  const warnings = [];
  if (env.SAAS_MAIL_MODE === 'central_forwarding') {
    warnings.push({
      code: 'central_forwarding_mode',
      severity: 'p1',
      message: 'Self-Service OAuth ist umgangen. Das ist schnell für Piloten, aber noch kein echter Zero-Touch-Gmail-Onboarding-Flow.'
    });
  }
  if (adminPassword && !adminPasswordHash) {
    warnings.push({
      code: 'plain_admin_password_env',
      severity: 'p1',
      message: 'ADMIN_PASSWORD funktioniert, aber für SaaS sollte nur ADMIN_PASSWORD_HASH genutzt werden.'
    });
  }

  return {
    checks,
    backup,
    blockers,
    warnings,
    ready: blockers.length === 0
  };
}

export async function inspectBackupState(env = process.env) {
  const backupDir = env.POSTGRES_BACKUP_DIR || env.BACKUP_DIR || '';
  const maxAgeHours = Number(env.POSTGRES_BACKUP_MAX_AGE_HOURS || 26);
  if (!backupDir) {
    return {
      configured: false,
      directory: null,
      latestFile: null,
      latestAt: null,
      latestAgeHours: null,
      maxAgeHours
    };
  }

  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const backups = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^eduard-.*\.sql\.gz$/.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(backupDir, entry.name);
        const stat = await fs.stat(filePath);
        return { name: entry.name, path: filePath, modifiedAt: stat.mtime.toISOString(), size: stat.size };
      }));
    backups.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    const latest = backups[0] || null;
    const latestAgeHours = latest ? Number(((Date.now() - new Date(latest.modifiedAt).getTime()) / 36e5).toFixed(2)) : null;
    return {
      configured: true,
      directory: backupDir,
      latestFile: latest?.name || null,
      latestAt: latest?.modifiedAt || null,
      latestAgeHours,
      maxAgeHours,
      count: backups.length,
      latestSizeBytes: latest?.size || 0
    };
  } catch (error) {
    return {
      configured: true,
      directory: backupDir,
      latestFile: null,
      latestAt: null,
      latestAgeHours: null,
      maxAgeHours,
      error: error.message
    };
  }
}

function check(id, ok, pass, fail) {
  return { id, ok: Boolean(ok), pass, fail, message: ok ? pass : fail };
}

function isStrongSecret(value, minLength) {
  const normalized = String(value || '').trim();
  if (normalized.length < minLength) return false;
  if (DEFAULT_VALUES.has(normalized)) return false;
  if (/change[_-]?me/i.test(normalized)) return false;
  return true;
}
