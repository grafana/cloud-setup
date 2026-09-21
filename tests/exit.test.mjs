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
