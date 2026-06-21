import fs from 'node:fs';
import { createPasswordHash } from '../src/auth.js';

const file = process.argv[2] || '.env.production';
let env = fs.readFileSync(file, 'utf8');
const password = (env.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1];
if (!password) {
  console.log(JSON.stringify({ ok: true, changed: false, reason: 'ADMIN_PASSWORD_missing' }));
  process.exit(0);
}
const hash = createPasswordHash(password.trim());
if (env.match(/^ADMIN_PASSWORD_HASH=/m)) {
  env = env.replace(/^ADMIN_PASSWORD_HASH=.*$/m, `ADMIN_PASSWORD_HASH=${hash}`);
} else {
  env = env.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD_HASH=${hash}\n# ADMIN_PASSWORD migrated to ADMIN_PASSWORD_HASH`);
}
env = env.replace(/^ADMIN_PASSWORD=.*$/m, '# ADMIN_PASSWORD migrated to ADMIN_PASSWORD_HASH');
fs.writeFileSync(file, env);
console.log(JSON.stringify({ ok: true, changed: true }));
