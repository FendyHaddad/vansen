import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, type Row } from '../testing/fakes.ts';
import { drainNotifications, type NotificationDeps } from './notifications.ts';
import type { PushEvent, ServiceAccount } from '../push.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const USER = 'u0';
const ACCOUNT = {
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key: 'k',
  project_id: 'p',
} as ServiceAccount;

interface Harness {
  db: FakeDb;
  deps: NotificationDeps;
  sends: { tokens: string[]; event: PushEvent }[];
  acks: Row[];
}

function harness(opts: {
  rows?: Row[];
  devices?: string[];
  account?: ServiceAccount | null;
  push?: (tokens: string[], event: PushEvent) => Promise<string[]>;
} = {}): Harness {
  const db = new FakeDb();
  db.tables.notification_outbox = opts.rows ?? [
    { id: 'n1', user_id: USER, generation_id: 'g1', event: 'generation_done', lease_token: null, sent_at: null, attempts: 0 },
  ];
  db.tables.devices = (opts.devices ?? ['tok-a']).map((token) => ({ user_id: USER, token }));
  const acks: Row[] = [];
  db.rpcHandlers.fn_claim_notifications = (args, self) => {
    const limit = Number(args.p_limit);
    const picked = (self.tables.notification_outbox ?? [])
      .filter((r) => r.sent_at === null && !r.lease_token)
      .slice(0, limit);
    for (const row of picked) {
      row.lease_token = `lease-${row.id}`;
      row.attempts = Number(row.attempts ?? 0) + 1;
    }
    return picked.map((r) => ({ ...r }));
  };
  db.rpcHandlers.fn_ack_notification = (args, self) => {
    acks.push(args);
    const row = (self.tables.notification_outbox ?? []).find((r) => r.id === args.p_id);
    if (!row || row.lease_token !== args.p_token) return false;
    row.sent_at = args.p_error === null ? '2026-09-21T00:00:00Z' : null;
    row.last_error = args.p_error;
    row.lease_token = null;
    return true;
  };
  const sends: { tokens: string[]; event: PushEvent }[] = [];
  return {
    db,
    sends,
    acks,
    deps: {
      admin: db as unknown as SupabaseClient,
      account: opts.account === undefined ? ACCOUNT : opts.account,
      sendPush: (_account, tokens, event) => {
        sends.push({ tokens, event });
        if (opts.push) return opts.push(tokens, event);
        return Promise.resolve([]);
      },
    },
  };
}

Deno.test('a claimed row is delivered once and acked as sent', async () => {
  const h = harness();
  const summary = await drainNotifications(h.deps);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0, abandoned: 0 });
  assertEquals(h.sends.length, 1);
  assertEquals(h.sends[0].tokens, ['tok-a']);
  assertEquals(h.sends[0].event.notificationId, 'n1', 'the client deduplicates on this');
  assertEquals(h.acks[0].p_error, null);
  assertEquals(h.db.tables.notification_outbox[0].sent_at, '2026-09-21T00:00:00Z');
});

Deno.test('a second drainer finds nothing left to send', async () => {
  const h = harness();
  await drainNotifications(h.deps);
  const second = await drainNotifications(h.deps);
  assertEquals(second.claimed, 0);
  assertEquals(h.sends.length, 1, 'one push per generation');
});

Deno.test('a push failure leaves the row unsent with a safe error code', async () => {
  const h = harness({ push: () => Promise.reject(new Error('fcm_send_failed 503')) });
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.failed, 1);
  assertEquals(h.acks[0].p_error, 'push_send_failed');
  assertEquals(h.db.tables.notification_outbox[0].sent_at, null, 'a failed send is not a delivery');
});

Deno.test('missing push configuration is a recorded fault, not a delivery', async () => {
  const h = harness({ account: null });
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.failed, 1);
  assertEquals(h.sends.length, 0);
  assertEquals(h.acks[0].p_error, 'push_not_configured');
  assertEquals(h.db.tables.notification_outbox[0].sent_at, null);
});

Deno.test('a user with no devices completes instead of retrying forever', async () => {
  const h = harness({ devices: [] });
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.sent, 1);
  assertEquals(h.sends.length, 0);
  assertEquals(h.acks[0].p_error, null);
});

Deno.test('a device lookup failure is retried, not swallowed', async () => {
  const h = harness();
  h.db.failNext('devices.select', 'connection reset');
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.failed, 1);
  assertEquals(h.acks[0].p_error, 'device_lookup_failed');
  assertEquals(h.sends.length, 0);
});

Deno.test('stale tokens returned by FCM are deleted', async () => {
  const h = harness({
    devices: ['tok-a', 'tok-dead'],
    push: () => Promise.resolve(['tok-dead']),
  });
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.sent, 1);
  assertEquals(h.db.tables.devices.map((d) => d.token), ['tok-a']);
  assertEquals(h.acks[0].p_error, null, 'dropping a dead device is still a success');
});

Deno.test('the ack carries the lease token the claim issued', async () => {
  const h = harness();
  await drainNotifications(h.deps);
  assertEquals(h.acks[0].p_token, 'lease-n1');
});

Deno.test('the drain stops before its lease expires instead of double-sending', async () => {
  const rows = ['n1', 'n2', 'n3'].map((id) => ({
    id, user_id: USER, generation_id: 'g1', event: 'generation_done',
    lease_token: null, sent_at: null, attempts: 0,
  }));
  const h = harness({ rows });
  // Each row takes two minutes of wall clock: only the first fits the budget.
  let ticks = 0;
  h.deps.now = () => {
    ticks += 1;
    return ticks * 60_000;
  };
  const summary = await drainNotifications(h.deps);
  assertEquals(summary.claimed, 3);
  assertEquals(summary.sent, 1);
  assertEquals(summary.abandoned, 2, 'the rest must be left for their leases to expire');
  assertEquals(h.sends.length, 1);
});

Deno.test('a claim failure is surfaced, not silently skipped', async () => {
  const h = harness();
  h.db.rpcHandlers.fn_claim_notifications = () => {
    throw new Error('deadlock detected');
  };
  let thrown = '';
  await drainNotifications(h.deps).catch((e) => {
    thrown = String(e);
  });
  assertEquals(thrown.includes('deadlock detected'), true);
});
