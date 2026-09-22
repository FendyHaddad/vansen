// Staging: the local Supabase stack from `supabase/config.toml`, brought up by
// `npm run stage`. `ng serve` uses this file (angular.json → development →
// fileReplacements); `ng build` uses environment.ts and still points at
// production.
//
// Until 2026-09-22 this file named the hosted project, so every `ng serve`
// session wrote to live data. See
// docs/superpowers/specs/2026-09-22-staging-environment-design.md.
//
// The key below is the Supabase CLI's fixed local development key. It is
// public by design and only valid against a stack on this machine.
export const environment = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
  apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api',
  // Nothing runs on a schedule locally, so staging must not promise that work
  // finishes after the last client closes. `npm run stage` ticks the job
  // worker only for as long as it is running.
  releaseCapabilities: {
    backgroundCompletion: false,
    completionNotifications: false,
  },
};
