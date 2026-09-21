// Production composition for the App Store webhook. Behaviour lives in handler.ts.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { appleVerifier } from './_shared/apple-verifier.ts';
import { createAppstoreWebhook } from './handler.ts';

Deno.serve(createAppstoreWebhook({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  verifyNotification: (p) => appleVerifier().verifyAndDecodeNotification(p),
  verifyTransaction: (t) => appleVerifier().verifyAndDecodeTransaction(t),
}));
