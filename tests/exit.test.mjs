import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const events = [];
mock.module('react', {
  defaultExport: {},
  namedExports: { useEffect() {}, useRef: (current) => ({ current }) },
});
mock.module('ink', { namedExports: { Box() {}, Text() {}, useInput() {}, useApp: () => ({ exit() {} }) } });
mock.module('ink-spinner', { defaultExport() {} });
mock.module('../dist/telemetry.js', {
  namedExports: {
    recordRun: (...args) => events.push(args),
    waitForTelemetry: () => new Promise(() => {}),
  },
});
const { useHardExit } = await import('../dist/ui/shared.js');

test('explicit incomplete setup survives a clean process exit', () => {
  useHardExit('frontend', 'stack')(undefined, 'incomplete');
  assert.equal(events.at(-1)[2], 'incomplete');
});

test('errors and cancellation take precedence over a setup result', (t) => {
  t.mock.method(console, 'log', () => {});
  useHardExit('frontend', 'stack')(new Error('failed'), 'ok');
  assert.equal(events.at(-1)[2], 'error');
  useHardExit('frontend', 'stack')('Cancelled.', 'ok');
  assert.equal(events.at(-1)[2], 'canceled');
});

test('multiple exit callbacks produce only one finished event', () => {
  const exit = useHardExit('frontend', 'stack');
  const before = events.length;
  exit(undefined, 'ok');
  exit(undefined, 'ok');
  assert.equal(events.length, before + 1);
});

// A cross-product recommendation hands off to the other wizard through this
// continuation. It must run, and a failure in it must not throw back into
// the caller — the process should still make its own way out.
test('an andThen continuation runs, and a rejection does not throw', async () => {
  let ranAndThen = false;
  const exit = useHardExit('frontend', 'stack');
  exit(undefined, 'ok', async () => {
    ranAndThen = true;
    throw new Error('boom');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ranAndThen, true);
});
