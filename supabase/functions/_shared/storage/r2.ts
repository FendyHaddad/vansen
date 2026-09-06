import { AwsClient } from 'npm:aws4fetch@1.0.20';
import type { StorageAdapter } from './types.ts';

export interface R2Env {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function envFromSecrets(): R2Env {
  const read = (k: string) => {
    const v = Deno.env.get(k);
    if (!v) throw new Error(`missing secret ${k}`);
    return v;
  };
  return {
    accountId: read('R2_ACCOUNT_ID'),
    accessKeyId: read('R2_ACCESS_KEY_ID'),
    secretAccessKey: read('R2_SECRET_ACCESS_KEY'),
    bucket: read('R2_BUCKET'),
  };
}

function clientFor(env: R2Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

export function r2ObjectUrl(path: string, env: R2Env = envFromSecrets()): string {
  return `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/${path}`;
}

export async function r2PresignedGet(path: string, ttlS: number, env: R2Env = envFromSecrets()): Promise<string> {
  const url = new URL(r2ObjectUrl(path, env));
  url.searchParams.set('X-Amz-Expires', String(ttlS));
  const signed = await clientFor(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

export const r2Storage: StorageAdapter = {
  backend: 'r2',
  async put(path, body, contentType) {
    const env = envFromSecrets();
    const res = await clientFor(env).fetch(r2ObjectUrl(path, env), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      // aws4fetch types BodyInit narrowly; Uint8Array is a valid fetch body.
      body,
    } as RequestInit);
    if (!res.ok) throw new Error(`r2 put failed: ${res.status} ${await res.text()}`);
  },
  signedUrl(path, ttlS) {
    return r2PresignedGet(path, ttlS);
  },
  async delete(path) {
    const env = envFromSecrets();
    const res = await clientFor(env).fetch(r2ObjectUrl(path, env), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`r2 delete failed: ${res.status}`);
  },
};
