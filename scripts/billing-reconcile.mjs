#!/usr/bin/env node
// Read-only billing reconciliation. Prints applied business transactions whose
// ledger effect is missing, and verified deliveries that never reached a
// transaction at all. It NEVER writes, and it never adjusts a balance: any
// repair is a separate, owner-approved action with its own record.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/billing-reconcile.mjs [--days 7]

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}

const daysFlag = process.argv.indexOf('--days');
const days = daysFlag === -1 ? 7 : Number(process.argv[daysFlag + 1]);
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(2);
}

const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
const admin = createClient(url, key);

const { data, error } = await admin.rpc('fn_paid_unfulfilled', { p_since: since });
if (error) {
  console.error('reconciliation query failed:', error.message);
  process.exit(2);
}

const rows = data ?? [];
console.log(`Billing reconciliation — applied transactions since ${since}`);
console.log(`Unfulfilled: ${rows.length}`);
for (const row of rows) {
  console.log(
    [
      row.applied_at,
      row.source,
      row.business_txn_id,
      row.user_id,
      row.kind,
      `${row.credits} cr`,
    ].join('  '),
  );
}
if (rows.length > 0) {
  console.log('\nNothing was changed. Investigate each row before any correction.');
  process.exit(1);
}
