import { assertEquals } from 'jsr:@std/assert';
import { fcmMessage, jwtClaims, parseServiceAccount } from './push.ts';

Deno.test('fcmMessage builds done notification with deep-link data', () => {
  const built = fcmMessage('tok-1', {
    type: 'generation_done',
    generationId: 'g1',
    notificationId: 'n1',
  });
  assertEquals(built.message.token, 'tok-1');
  // The id travels in `data` so the client can deduplicate: delivery is at
  // least once, and a repeat of the same notification must not show twice.
  assertEquals(built.message.data, {
    type: 'generation_done',
    generationId: 'g1',
    notificationId: 'n1',
  });
  assertEquals(built.message.notification.title, 'Generation complete');
  assertEquals(built.message.notification.body, 'Your image is ready.');
  assertEquals(built.message.android.priority, 'HIGH');
});

Deno.test('fcmMessage builds failed notification with refund copy', () => {
  const built = fcmMessage('tok-1', {
    type: 'generation_failed',
    generationId: 'g1',
    notificationId: 'n2',
  });
  assertEquals(built.message.notification.title, 'Generation failed');
  assertEquals(built.message.notification.body, 'Credits refunded.');
  assertEquals(built.message.data.type, 'generation_failed');
  assertEquals(built.message.data.notificationId, 'n2');
});

Deno.test('the fcm payload serializes the notification id as a string', () => {
  // FCM `data` values must be strings; a number or an object is rejected at
  // send time, which would look like an outage rather than a bug.
  const built = fcmMessage('tok-1', {
    type: 'generation_done',
    generationId: 'g1',
    notificationId: 'ba6a2e2e-0000-4000-8000-000000000001',
  });
  const round = JSON.parse(JSON.stringify(built)) as typeof built;
  for (const value of Object.values(round.message.data)) {
    assertEquals(typeof value, 'string');
  }
  assertEquals(round.message.data.notificationId, 'ba6a2e2e-0000-4000-8000-000000000001');
});

Deno.test('jwtClaims scopes firebase messaging for one hour', () => {
  const claims = jwtClaims('svc@p.iam.gserviceaccount.com', 1_000);
  assertEquals(claims.iss, 'svc@p.iam.gserviceaccount.com');
  assertEquals(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assertEquals(claims.aud, 'https://oauth2.googleapis.com/token');
  assertEquals(claims.iat, 1_000);
  assertEquals(claims.exp, 4_600);
});

Deno.test('parseServiceAccount rejects missing or malformed input', () => {
  assertEquals(parseServiceAccount(undefined), null);
  assertEquals(parseServiceAccount('not json'), null);
  assertEquals(parseServiceAccount('{"client_email":"a"}'), null);
});

Deno.test('parseServiceAccount accepts a complete key', () => {
  const raw = JSON.stringify({
    client_email: 'svc@p.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    project_id: 'vansen',
  });
  assertEquals(parseServiceAccount(raw)?.project_id, 'vansen');
});
