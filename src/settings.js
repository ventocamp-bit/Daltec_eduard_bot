import fs from 'node:fs/promises';
import path from 'node:path';
import { tenantContext } from './tenant-context.js';

export const SETTINGS_PATH = path.resolve('data/settings.json');
const EXAMPLE_PATH = path.resolve('data/settings.example.json');

export async function loadSettings(context = {}) {
  const paths = getSettingsPaths(context);
  await ensureSettingsFile(paths);
  return mergeSettings(await loadDefaultSettings(), JSON.parse(await fs.readFile(paths.settingsPath, 'utf8')));
}

export async function saveSettings(settings, context = {}) {
  const paths = getSettingsPaths(context);
  await fs.mkdir(path.dirname(paths.settingsPath), { recursive: true });
  const existing = await loadExistingSettings(paths);
  const normalized = mergeSettings(mergeSettings(await loadDefaultSettings(), existing), settings);
  delete normalized.mail?.cc;
  if (normalized.mail?.internalSubject && !normalized.mail.subject) {
    normalized.mail.subject = normalized.mail.internalSubject;
  }
  delete normalized.mail?.internalSubject;
  delete normalized.data?.preislisteCsvPath;
  normalized.data ||= {};
  normalized.data.lagerCsvPath = paths.inventoryPath;
  await fs.writeFile(paths.settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function loadDefaultSettings() {
  return JSON.parse(await fs.readFile(EXAMPLE_PATH, 'utf8'));
}

async function ensureSettingsFile(paths) {
  try {
    await fs.access(paths.settingsPath);
  } catch {
    await fs.mkdir(path.dirname(paths.settingsPath), { recursive: true });
    const seed = await loadSeedSettings(paths);
    seed.data ||= {};
    seed.data.lagerCsvPath = paths.inventoryPath;
    await fs.writeFile(paths.settingsPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  }
}

async function loadExistingSettings(paths) {
  try {
    return JSON.parse(await fs.readFile(paths.settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

async function loadSeedSettings(paths) {
  try {
    if (paths.settingsPath !== SETTINGS_PATH) {
      return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
    }
  } catch {}
  return loadDefaultSettings();
}

function getSettingsPaths(context = {}) {
  if (context.settingsPath && context.inventoryPath) return context;
  return tenantContext(context);
}

function mergeSettings(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeSettings(base[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
