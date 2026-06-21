import dotenv from 'dotenv';
import { sendReviewReminderIfDue } from '../src/review-digest.js';

dotenv.config({ path: '.env.production' });
dotenv.config();

const tenantId = process.argv[2] || process.env.ADMIN_TENANT_ID || 'daltec-local';
const result = await sendReviewReminderIfDue({ tenantId });
console.log(JSON.stringify(result, null, 2));
