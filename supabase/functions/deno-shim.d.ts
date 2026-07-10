// Editor-only type shims so the IDE can check edge functions without the Deno
// language service. At runtime Deno provides the real globals and resolves
// jsr:/npm: specifiers itself — this file is never deployed or executed.
// The jsr:/npm: modules delegate to the matching npm packages installed as
// devDependencies (hono, stripe, @supabase/supabase-js) purely for types.

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

declare module 'jsr:@hono/hono' {
  export * from 'hono';
}

declare module 'jsr:@hono/hono/cors' {
  export * from 'hono/cors';
}

declare module 'jsr:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js';
}

declare module 'npm:stripe@17' {
  import Stripe from 'stripe';
  export default Stripe;
}
