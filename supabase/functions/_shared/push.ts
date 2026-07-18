// FCM HTTP v1 sender. Mints a service-account OAuth2 token (RS256 JWT →
// google token endpoint), then posts one message per device token.

export type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id: string;
};

export type PushEvent = {
  type: 'generation_done' | 'generation_failed';
  generationId: string;
};

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) return null;
    return parsed as ServiceAccount;
  } catch {
    return null;
  }
}

export function fcmMessage(token: string, event: PushEvent) {
  const done = event.type === 'generation_done';
  return {
    message: {
      token,
      notification: {
        title: done ? 'Generation complete' : 'Generation failed',
        body: done ? 'Your image is ready.' : 'Credits refunded.',
      },
      data: { type: event.type, generationId: event.generationId },
      android: { priority: 'HIGH' },
      apns: { payload: { aps: { sound: 'default' } } },
    },
  };
}

export function jwtClaims(clientEmail: string, nowSeconds: number) {
  return {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replaceAll('\n', '');
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signedAssertion(account: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson(jwtClaims(account.client_email, nowSeconds));
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function accessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs) return cachedToken.token;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = await signedAssertion(account, nowSeconds);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) {
    throw new Error(`fcm_token_mint_failed ${response.status}`);
  }
  cachedToken = { token: json.access_token, expiresAtMs: (nowSeconds + 3300) * 1000 };
  return json.access_token;
}

export async function sendGenerationPush(
  account: ServiceAccount,
  tokens: string[],
  event: PushEvent,
): Promise<string[]> {
  const bearer = await accessToken(account);
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const stale: string[] = [];
  for (const token of tokens) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fcmMessage(token, event)),
    });
    const text = await response.text();
    if (response.status === 404 || response.status === 410) stale.push(token);
    if (!response.ok) console.error('fcm_send_failed', response.status, text.slice(0, 300));
  }
  return stale;
}
