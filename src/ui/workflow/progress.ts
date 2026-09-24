export interface FakeProgress {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  finish: () => Promise<void>;
}

// Purely decorative — for steps with no real progress signal to show (one
// opaque await, or a mix of local work and a confirm question), this fakes
// one, paced against a wall-clock target rather than random step sizes so
// it reads as roughly "on schedule" instead of jittery. Real work almost
// always finishes before that target — finish() is the deliberate "speed
// up" for when it does, sprinting the number up to 100 instead of letting
// it jump there.
export function startFakeProgress(
  onProgress: (percent: number) => void,
  isCancelled: () => boolean,
  targetMs: number,
): FakeProgress {
  const startedAt = Date.now();
  // Time spent paused doesn't count toward elapsed — otherwise resuming
  // after, say, a slow answer to a confirm question would jump the number
  // ahead to "catch up" to real elapsed time, which is exactly the jump
  // this is meant to avoid.
  let pausedMs = 0;
  let pauseStartedAt: number | undefined;
  let percent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function tick() {
    if (stopped || pauseStartedAt !== undefined || isCancelled()) return;
    const elapsed = Date.now() - startedAt - pausedMs;
    // Small jitter so it doesn't read as a perfectly straight line, but
    // never lets it fall behind its own previous value.
    const paced = (elapsed / targetMs) * 100 + (Math.random() * 4 - 2);
    percent = Math.max(percent, Math.min(99, Math.round(paced)));
    onProgress(percent);
    timer = setTimeout(tick, 250 + Math.random() * 250);
  }
  tick();

  function pause() {
    if (stopped || pauseStartedAt !== undefined) return;
    pauseStartedAt = Date.now();
    if (timer) clearTimeout(timer);
  }

  function resume() {
    if (stopped || pauseStartedAt === undefined) return;
    pausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = undefined;
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  function finish(): Promise<void> {
    stop();
    return new Promise((resolve) => {
      function burst() {
        if (isCancelled()) {
          resolve();
          return;
        }
        percent = Math.min(100, percent + Math.max(2, Math.round((100 - percent) * 0.35)));
        onProgress(percent);
        if (percent >= 100) {
          resolve();
          return;
        }
        setTimeout(burst, 40 + Math.random() * 40);
      }
      burst();
    });
  }

  return { pause, resume, stop, finish };
}
