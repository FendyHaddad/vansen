import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { r2ObjectUrl, r2PresignedGet } from './r2.ts';

const env = {
  accountId: 'acct123',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'vansen-media',
};

Deno.test('r2ObjectUrl builds the S3-compatible object URL', () => {
  assertEquals(
    r2ObjectUrl('videos/u1/g1.mp4', env),
    'https://acct123.r2.cloudflarestorage.com/vansen-media/videos/u1/g1.mp4',
  );
});

Deno.test('r2PresignedGet returns a SigV4 query-signed URL with the requested TTL', async () => {
  const url = await r2PresignedGet('videos/u1/g1.mp4', 604800, env);
  assertStringIncludes(url, 'https://acct123.r2.cloudflarestorage.com/vansen-media/videos/u1/g1.mp4?');
  assertStringIncludes(url, 'X-Amz-Expires=604800');
  assertStringIncludes(url, 'X-Amz-Signature=');
  assertStringIncludes(url, 'X-Amz-Credential=AKIAEXAMPLE');
});
