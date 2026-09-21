// Production composition for the cleanup worker. Behaviour lives in handler.ts.
//
// pg_cron pokes this every five minutes with the shared secret. It is the only
// place bytes are removed from storage and the only place an auth user is
// deleted, so `_shared/storage` must be bundled with this function on deploy.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createCleanupWorker } from './handler.ts';
import { r2Storage } from './_shared/storage/r2.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// The bucket is read once, from the environment this deployment actually
// writes to. A row naming any other R2 bucket is a bad locator and is refused
// rather than deleted from ours.
const r2Bucket = Deno.env.get('R2_BUCKET') ?? '';

const worker = createCleanupWorker({
  admin,
  workerSecret: Deno.env.get('CLEANUP_WORKER_SECRET') ?? null,
  objects: { r2Bucket, r2: r2Storage },
  async deleteAuthUser(userId: string) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    // The user already being absent is the state we wanted; anything else
    // keeps the closure open.
    if (error && !/not.?found/i.test(error.message)) {
      throw new Error(`auth_delete_failed: ${error.message}`);
    }
  },
});

Deno.serve(worker);
