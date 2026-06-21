import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.production' });
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const backupDir = process.env.POSTGRES_BACKUP_DIR || process.env.BACKUP_DIR || path.resolve('backups');
const retentionDays = Number(process.env.POSTGRES_BACKUP_RETENTION_DAYS || 14);

if (!databaseUrl) {
  console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL_missing' }));
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `eduard-${timestamp}.sql.gz`);

await fs.mkdir(backupDir, { recursive: true });
await runPgDump(databaseUrl, backupPath);
await pruneOldBackups(backupDir, retentionDays);

const stat = await fs.stat(backupPath);
console.log(JSON.stringify({
  ok: true,
  backupPath,
  sizeBytes: stat.size,
  retentionDays
}, null, 2));

async function runPgDump(url, targetPath) {
  await new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', [url, '--no-owner', '--no-privileges'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const gzip = createGzip({ level: 9 });
    const output = createWriteStream(targetPath);
    const errors = [];

    dump.stderr.on('data', (chunk) => errors.push(chunk.toString()));
    dump.on('error', reject);
    gzip.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    dump.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump_failed_${code}: ${errors.join('').trim()}`));
      }
    });

    dump.stdout.pipe(gzip).pipe(output);
  });
}

async function pruneOldBackups(dir, days) {
  const cutoff = Date.now() - days * 24 * 36e5;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^eduard-.*\.sql\.gz$/.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtime.getTime() < cutoff) await fs.unlink(filePath);
    }));
}
