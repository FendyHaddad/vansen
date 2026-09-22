#!/usr/bin/env node
/**
 * Bring staging up: the Supabase containers, the five Edge Functions, a job
 * worker tick, and `ng serve` against all of it.
 *
 *   node scripts/stage.mjs         start everything, Ctrl-C to stop
 *   node scripts/stage.mjs stop    also stop the containers
 *
 * Everything this starts dies with it. The worker tick is a timer in this
 * process, not a cron job, so a forgotten staging session cannot keep calling
 * providers after the terminal is closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { API_URL, SERVICE_ROLE_KEY, STAGING_USERS } from './stage-seed.mjs';
import { ENV_PATH, EXAMPLE_PATH, familyPlan, loadStagingEnv } from './stage-env.mjs';

export const WORKER_INTERVAL_MS = 15_000;

export function serveArgs() {
  return ['functions', 'serve', '--no-verify-jwt', '--env-file', ENV_PATH];
}

export function tickRequest(env) {
  const secret = env.JOB_WORKER_SECRET;
  if (!secret) throw new Error(`JOB_WORKER_SECRET is missing from ${ENV_PATH}`);
  return {
    url: `${API_URL}/functions/v1/job-worker`,
    init: {
      method: 'POST',
      headers: {
        'x-worker-secret': secret,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    },
  };
}

function stackRunning() {
  return spawnSync('supabase', ['status'], { encoding: 'utf8' }).status === 0;
}

export const STOP_GRACE_MS = 10_000;

/** Signals the child's whole process group. Both `supabase` and `npx` are
 * wrappers that fork the real binary; a signal to the wrapper alone leaves
 * that grandchild running, reparented to launchd, after we are gone. The
 * children are spawned `detached` so each has a group of its own to signal. */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // Already gone; nothing left to signal.
    if (error.code === 'ESRCH') return;
    throw error;
  }
}

/** Asks a child to stop the way Ctrl-C would, waits for it, and only after
 * ten seconds of silence kills it outright. Resolves at once for a child
 * that has already exited, so shutdown never hangs on a corpse. */
export function stopChild(child, signal = signalGroup) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    // Also resolves: a child whose signals both fail must not hang shutdown forever.
    const force = setTimeout(() => {
      signal(child, 'SIGKILL');
      resolve();
    }, STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    signal(child, 'SIGINT');
  });
}

export function stop({ run = spawnSync, log = console.log } = {}) {
  const result = run('supabase', ['stop'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('supabase stop failed');
  log('staging stopped.');
}

async function start() {
  const env = loadStagingEnv();
  // A missing Stripe key stops the api booting; a missing origin breaks every thumbnail.
  for (const name of ['STRIPE_SECRET_KEY', 'MEDIA_PUBLIC_ORIGIN']) {
    if (!env[name]) throw new Error(`${name} is missing from ${ENV_PATH} — copy the line from ${EXAMPLE_PATH}`);
  }
  const plan = familyPlan(env);
  const tick = tickRequest(env);

  if (!stackRunning()) {
    console.log('starting the Supabase stack...');
    const started = spawnSync('supabase', ['start'], { stdio: 'inherit' });
    if (started.status !== 0) throw new Error('could not start the stack (is Docker running?)');
  }

  // detached: each child leads its own process group, which is what stopChild
  // signals. The terminal is still shared through stdio: 'inherit'.
  const children = [
    spawn('supabase', serveArgs(), { stdio: 'inherit', detached: true }),
    spawn('npx', ['ng', 'serve'], { stdio: 'inherit', detached: true }),
  ];

  const ticker = setInterval(() => {
    fetch(tick.url, tick.init).catch(() => {});
  }, WORKER_INTERVAL_MS);

  // One exit path. Ctrl-C, a kill, or either child dying on its own all end
  // with every child gone before this process is, so nothing is orphaned.
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    // Not `.map(stopChild)`: map would pass the index as stopChild's signal.
    await Promise.all(children.map((child) => stopChild(child)));
    process.exit(code);
  };
  // Wrapped: Node hands a signal handler the signal's name, which must not
  // become the exit code.
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  for (const child of children) child.once('exit', (code) => shutdown(code ?? 0));

  console.log('');
  console.log('staging is up:');
  console.log('  app       http://localhost:4200');
  console.log('  studio    http://127.0.0.1:54323');
  console.log('  mail      http://127.0.0.1:54324');
  console.log(`  families  ${plan.enabled.join(', ') || 'none (no provider keys)'}`);
  console.log(`  sign in   ${STAGING_USERS[1].email} / staging-pass`);
  console.log('');
  console.log('Ctrl-C stops the functions and the dev server. The containers keep');
  console.log('running; `npm run stage:stop` stops those too.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const task = process.argv[2] === 'stop' ? async () => stop() : start;
  task().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
