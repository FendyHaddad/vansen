// Shared Gemini/Veo wiring — one API base, one key read, one header builder for
// the image (google.ts), video (google-video.ts) and omni (google-omni.ts) adapters.

export const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function googleKey(): string {
  const k = Deno.env.get('GOOGLE_AI_API_KEY');
  if (!k) throw new Error('GOOGLE_AI_API_KEY not set');
  return k;
}

export function googleHeaders(): Record<string, string> {
  return { 'x-goog-api-key': googleKey(), 'Content-Type': 'application/json' };
}
