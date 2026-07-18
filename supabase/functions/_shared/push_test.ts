import { assertEquals } from 'jsr:@std/assert';
import { fcmMessage, jwtClaims, parseServiceAccount } from './push.ts';

Deno.test('fcmMessage builds done notification with deep-link data', () => {
  const built = fcmMessage('tok-1', { type: 'generation_done', generationId: 'g1' });
  assertEquals(built.message.token, 'tok-1');
  assertEquals(built.message.data, { type: 'generation_done', generationId: 'g1' });
  assertEquals(built.message.notification.title, 'Generation complete');
  assertEquals(built.message.notification.body, 'Your image is ready.');
  assertEquals(built.message.android.priority, 'HIGH');
});

Deno.test('fcmMessage builds failed notification with refund copy', () => {
  const built = fcmMessage('tok-1', { type: 'generation_failed', generationId: 'g1' });
  assertEquals(built.message.notification.title, 'Generation failed');
  assertEquals(built.message.notification.body, 'Credits refunded.');
  assertEquals(built.message.data.type, 'generation_failed');
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
