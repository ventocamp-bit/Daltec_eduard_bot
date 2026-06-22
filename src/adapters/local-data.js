import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

export async function readCsvObjects(filePath) {
  const content = decodeCsvBuffer(await fs.readFile(filePath));
  return parseCsvObjectsFromText(content);
}

export async function atomicWriteFile(filePath, content, options = {}) {
  const writer = options.writeFile || fs.writeFile;
  const renamer = options.rename || fs.rename;
  const unlinker = options.unlink || fs.unlink;
  const encoding = options.encoding || 'utf8';
  const target = path.resolve(filePath);
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  try {
    await writer(tempPath, content, encoding);
    await renamer(tempPath, target);
  } catch (error) {
    await unlinker(tempPath).catch(() => null);
    throw error;
  }
}

export function decodeCsvBuffer(input) {
  if (typeof input === 'string') return input;
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function parseCsvObjectsFromText(content) {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1)
    .filter((row) => row.some((cell) => String(cell || '').trim() !== ''))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fileMetadata(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch {
    return {
      exists: false,
      size: 0,
      modifiedAt: null
    };
  }
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ';' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === ',' && !inQuotes && content.includes(',') && !content.includes(';')) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}
