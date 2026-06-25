import { loadConfig } from './src/config.js';
import { createMailRuntime } from './src/mail-runtime.js';
import { loadOfferRun, updateOfferRun } from './src/postgres-storage.js';

(async () => {
  try {
    const runId = '9944aa71-d9c4-434c-981f-545dbdc6b995';
    const tenantContext = { dealerId: 'daltec' };
    const run = await loadOfferRun(runId, tenantContext);
    if (!run) {
      console.error('Run not found');
      process.exit(1);
    }
    const config = loadConfig();
    const runtime = await createMailRuntime(config, tenantContext);
    await runtime.sendHtmlMail(runtime.client, {
      to: 'ventocamp@gmail.com',
      cc: '',
      subject: run.draft_subject,
      html: run.draft_html
    });
    const sentAt = new Date().toISOString();
    await updateOfferRun(runId, {
      status: 'sent_to_customer',
      completed_at: sentAt,
    }, tenantContext);
    console.log('SENT to ventocamp@gmail.com!');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
