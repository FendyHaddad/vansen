import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, OTHER_USER, TEST_USER } from './testing/fakes.ts';
import { isCanonicalUploadPath, resolveOwnedUpload } from './reference-resolver.ts';

const MINE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const THEIRS = `${OTHER_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

function dbWith(rows: Record<string, unknown>[]): FakeDb {
  const db = new FakeDb();
  db.tables.uploads = rows;
  return db;
}

Deno.test('canonical path check rejects traversal, quarantine and foreign prefixes', () => {
  assertEquals(isCanonicalUploadPath(MINE, TEST_USER), true);
  assertEquals(isCanonicalUploadPath(THEIRS, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`quarantine/${TEST_USER}/x.png`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`scratch/${TEST_USER}/x.png`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`${TEST_USER}/../../etc/passwd`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`persona-zips/${TEST_USER}/p.zip`, TEST_USER), false);
});

Deno.test('own, moderated upload resolves', async () => {
  const db = dbWith([
    {
      id: 'u1',
      user_id: TEST_USER,
      path: MINE,
      purpose: 'reference',
      mime: 'image/png',
      width: 1024,
      height: 1024,
      moderation: 'allowed',
    },
  ]);
  const result = await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference');
  assertEquals(result, { path: MINE, mime: 'image/png', width: 1024, height: 1024 });
});

Deno.test("another user's upload is not owned even when the row exists", async () => {
  const db = dbWith([
    {
      id: 'u2',
      user_id: OTHER_USER,
      path: THEIRS,
      purpose: 'reference',
      mime: 'image/png',
      width: 10,
      height: 10,
      moderation: 'allowed',
    },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, THEIRS, 'reference'), 'not_owned');
});

Deno.test('an unregistered path is not found even if it looks canonical', async () => {
  const db = dbWith([]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'not_found');
});

Deno.test('an unmoderated upload is refused', async () => {
  const db = dbWith([
    {
      id: 'u3',
      user_id: TEST_USER,
      path: MINE,
      purpose: 'reference',
      mime: 'image/png',
      width: 10,
      height: 10,
      moderation: 'pending',
    },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'not_moderated');
});

Deno.test('a persona photo cannot be used as a generation reference', async () => {
  const db = dbWith([
    {
      id: 'u4',
      user_id: TEST_USER,
      path: MINE,
      purpose: 'persona-photo',
      mime: 'image/png',
      width: 10,
      height: 10,
      moderation: 'allowed',
    },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'wrong_purpose');
});
