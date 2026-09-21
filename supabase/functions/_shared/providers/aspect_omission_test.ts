import { assert, assertEquals } from 'jsr:@std/assert';
import { captureFetch } from './testing/capture.ts';
import { googleVideoAdapter } from './google-video.ts';
import { googleOmniAdapter } from './google-omni.ts';
import { runwayAdapter } from './runway.ts';
import { falAdapter } from './fal.ts';
import { familyById } from '../model-families.ts';

const ADAPTERS = [
  { name: 'veo', adapter: googleVideoAdapter },
  { name: 'omni', adapter: googleOmniAdapter },
  { name: 'runway', adapter: runwayAdapter },
  { name: 'kling', adapter: falAdapter },
  { name: 'seedance', adapter: falAdapter },
];
for (const key of ['GOOGLE_AI_API_KEY','RUNWAY_API_KEY','FAL_API_KEY']) Deno.env.set(key,'test-key');
for (const { name, adapter } of ADAPTERS) {
  const modes = familyById(name)!.capabilities.modes ?? [];
  for (const mode of modes.filter((m) => ['t2v','i2v','keyframes'].includes(m))) {
    Deno.test(`R25: ${name} aspect contract for ${mode}`, async () => {
      const capture = captureFetch((call) => {
        if (call.method !== 'POST') return new Response(new Uint8Array([1,2,3]), {headers:{'content-type':'image/png'}});
        return new Response(JSON.stringify({
          name:'operations/test', id:'task-test',
          status_url:'https://queue.fal.run/fal-ai/test/requests/one/status',
          response_url:'https://queue.fal.run/fal-ai/test/requests/one',
        }), {status:200,headers:{'content-type':'application/json'}});
      });
      try {
        await adapter.submit({
          familyId:name, op:'generate', prompt:'a cat', mode,
          settings:{aspectRatio:'16:9',resolution:'720p',durationS:5},
          referenceUrls:mode === 'keyframes' ? ['https://x/first.png','https://x/last.png'] : ['https://x/first.png'],
          safetyId:'sha',
        });
        const sent = capture.calls.find((call) => call.method === 'POST' && call.jsonBody);
        assert(sent?.jsonBody, 'adapter must send a provider request');
        const body = JSON.stringify(sent.jsonBody);
        const hasAspect = /"(aspectRatio|aspect_ratio|ratio)"/.test(body);
        assertEquals(hasAspect, mode === 't2v', name + '/' + mode);
      } finally { capture.restore(); }
    });
  }
}
