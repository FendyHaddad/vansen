import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';

const API_BASE = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';
const MODEL = 'gen4.5';

function key(): string {
  const k = Deno.env.get('RUNWAY_API_KEY');
  if (!k) throw new Error('RUNWAY_API_KEY not set');
  return k;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${key()}`,
    'X-Runway-Version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

const RATIOS: Record<string, Record<string, string>> = {
  '16:9': { '720p': '1280:720', '1080p': '1920:1080' },
  '9:16': { '720p': '720:1280', '1080p': '1080:1920' },
  '1:1': { '720p': '960:960', '1080p': '1080:1080' },
};

export function runwayRatio(aspectRatio: unknown, resolution: unknown): string {
  const byRes = RATIOS[String(aspectRatio)] ?? RATIOS['16:9'];
  return byRes[String(resolution)] ?? byRes['720p'];
}

function isBlocked(code: string | undefined, message: string | undefined): boolean {
  const text = `${code ?? ''} ${message ?? ''}`.toUpperCase();
  return text.includes('SAFETY') || text.includes('MODERATION');
}

export const runwayAdapter: ProviderAdapter = {
  provider: 'runway',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const mode = ctx.mode ?? 't2v';
    if (mode !== 't2v' && mode !== 'i2v') throw new Error('unsupported_mode');
    const ref = ctx.referenceUrls?.[0];
    if (mode === 'i2v' && !ref) throw new Error('missing_reference');
    const s = ctx.settings;
    const body: Record<string, unknown> = {
      model: MODEL,
      promptText: ctx.prompt,
      ratio: runwayRatio(s.aspectRatio, s.resolution),
      duration: typeof s.durationS === 'number' ? s.durationS : 5,
    };
    const endpoint = mode === 'i2v' ? 'image_to_video' : 'text_to_video';
    if (mode === 'i2v') body.promptImage = ref;
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`runway submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('runway submit: missing task id');
    return { providerRef: data.id };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^[\w-]+$/.test(providerRef)) return { state: 'failed', error: 'bad_provider_ref' };
    const res = await fetch(`${API_BASE}/tasks/${providerRef}`, { headers: headers() });
    if (!res.ok) throw new Error(`runway poll ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const t = (await res.json()) as {
      status: string;
      progress?: number;
      output?: string[];
      failure?: string;
      failureCode?: string;
    };
    if (t.status === 'PENDING' || t.status === 'THROTTLED') return { state: 'running', phase: 'queued' };
    if (t.status === 'RUNNING' && typeof t.progress === 'number') {
      return { state: 'running', phase: 'rendering', progress: t.progress };
    }
    if (t.status === 'RUNNING') return { state: 'running', phase: 'rendering' };
    if (t.status === 'SUCCEEDED' && t.output?.[0]) {
      return { state: 'done', url: t.output[0], contentType: 'video/mp4' };
    }
    if (t.status === 'CANCELLED') return { state: 'failed', error: 'cancelled' };
    return { state: 'failed', error: isBlocked(t.failureCode, t.failure) ? 'provider_blocked' : 'provider_failed' };
  },

  async cancel(providerRef: string): Promise<void> {
    if (!/^[\w-]+$/.test(providerRef)) return;
    const res = await fetch(`${API_BASE}/tasks/${providerRef}`, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error(`runway cancel ${res.status}: ${(await res.text()).slice(0, 300)}`);
  },
};
