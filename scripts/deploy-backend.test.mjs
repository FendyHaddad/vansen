import { strict as assert } from 'node:assert';
import test from 'node:test';
import { deployBackend } from './deploy-backend.mjs';
const components = ['api','job-worker','cleanup-worker','stripe-webhook','appstore-webhook'];
function harness(fail = null) {
  const calls = [];
  return { calls, run(cmd,args) {
    calls.push([cmd,...args]);
    if (args[1] === 'deploy') return { status: args[2] === fail ? 1 : 0, stderr: 'deployment failed' };
    return { status: 0, stdout: JSON.stringify(components.map((slug,i) => ({ slug, version: i+10 }))) };
  } };
}
test('every shared-code consumer is deployed and its own version attested', () => {
  const h = harness();
  const receipt = deployBackend({ projectRef: 'test-project', revision: 'abc1234', run: h.run });
  assert.deepEqual(h.calls.filter(c => c[2] === 'deploy').map(c => c[3]), components);
  assert.equal(receipt.components['api'].version, 10);
  assert.equal(receipt.components['job-worker'].version, 11);
  assert.equal(receipt.components['stripe-webhook'].revision, 'abc1234');
});
test('failed component halts deployment before attesting success', () => {
  const h = harness('job-worker');
  assert.throws(() => deployBackend({projectRef:'test', revision:'abc1234',run:h.run}), /job-worker/);
  assert.equal(h.calls.some(c => c[3] === 'cleanup-worker'), false);
});
test('missing component version cannot produce an attestation', () => {
  const h = harness();
  assert.throws(() => deployBackend({projectRef:'test',revision:'abc1234',run:(cmd,args) =>
    args[1] === 'list' ? {status:0,stdout:'[]'} : h.run(cmd,args)}), /version/);
});
