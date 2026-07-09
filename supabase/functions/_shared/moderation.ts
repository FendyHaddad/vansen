// Universal moderation gate — runs on every prompt and every uploaded image
// BEFORE any provider sees them. OpenAI omni-moderation (free, multimodal).

interface ModerationResult {
  flagged: boolean;
  categories: Record<string, number>;
}

export async function moderate(input: { text?: string; imageUrl?: string }): Promise<ModerationResult> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) {
    // No key configured — cannot gate. Fail OPEN so we never block legitimate users
    // on our own misconfiguration; provider-native filters remain the backstop.
    console.error('moderation skipped: OPENAI_API_KEY missing');
    return { flagged: false, categories: {} };
  }

  const parts: unknown[] = [];
  if (input.text) parts.push({ type: 'text', text: input.text });
  if (input.imageUrl) parts.push({ type: 'image_url', image_url: { url: input.imageUrl } });
  if (parts.length === 0) return { flagged: false, categories: {} };

  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: parts }),
    });
    if (!res.ok) {
      // Our moderation call failed (their outage / rate limit). Fail OPEN, log loudly.
      console.error('moderation api error', res.status);
      return { flagged: false, categories: {} };
    }
    const data = await res.json();
    const result = data.results?.[0];
    return {
      flagged: result?.flagged === true,
      categories: result?.category_scores ?? {},
    };
  } catch (e) {
    console.error('moderation request threw', e);
    return { flagged: false, categories: {} };
  }
}
