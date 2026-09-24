import type { Outcome, StepProperties } from "../../telemetry.js";

export interface WorkflowState<Step extends string = string> {
  currentStep: Step;
  started: boolean;
  completed: ReadonlySet<Step>;
  results: Partial<Record<Step, StepProperties>>;
  // Retained across repeated passes, even when the latest step result is OK.
  failedSteps: ReadonlySet<Step>;
  done: boolean;
  failureSummary?: string;
  prompt?: string;
  outcome: Outcome;
}

export interface StepResult<Step extends string> {
  properties?: StepProperties;
  next: Step | "done";
}

export interface StepContext<State extends WorkflowState, Inputs extends object> {
  readonly signal: AbortSignal;
  get(): State;
  update(patch: Partial<State>): void;
  wait<T>(operation: Promise<T>): Promise<T>;
  ask<Key extends keyof Inputs & string>(prompt: Key): Promise<Inputs[Key]>;
  onCleanup(cleanup: () => void): void;
}

export type StepHandlers<State extends WorkflowState, Inputs extends object> = {
  [Step in State["currentStep"]]: (context: StepContext<State, Inputs>) => Promise<StepResult<State["currentStep"]>>;
};

// Owns one active step and at most one pending question. Rendering subscribes
// to snapshots. Restarting a step cancels its question and ignores stale work.
export class WorkflowController<State extends WorkflowState, Inputs extends object> {
  private listeners = new Set<() => void>();
  private active?: AbortController;
  private pending?: { key: keyof Inputs & string; answer: (value: unknown) => void };

  constructor(
    private state: State,
    private handlers: StepHandlers<State, Inputs>,
    private record: (step: State["currentStep"], properties: StepProperties) => void,
    private requiredSteps: ReadonlyArray<State["currentStep"]>,
  ) {}

  getSnapshot = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<State> | Partial<WorkflowState<State["currentStep"]>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.state.started) return;
    this.update({ started: true });
    this.run(this.state.currentStep);
  }

  answer<Key extends keyof Inputs & string>(key: Key, value: Inputs[Key]): void {
    if (this.pending?.key !== key) return;
    const pending = this.pending;
    this.pending = undefined;
    this.update({ prompt: undefined });
    pending.answer(value);
  }

  restart(step: State["currentStep"]): void {
    if (!this.state.started || this.state.done || this.state.failureSummary) return;
    this.run(step);
  }

  dispose(): void {
    this.active?.abort();
    this.pending = undefined;
  }

  private run(step: State["currentStep"]): void {
    this.dispose();
    const active = new AbortController();
    this.active = active;
    const { signal } = active;
    const checkActive = () => signal.throwIfAborted();
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      checkActive();
      let abort: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Workflow step cancelled", { cause: signal.reason }));
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        const value = await Promise.race([operation, cancelled]);
        checkActive();
        return value;
      } finally {
        signal.removeEventListener("abort", abort!);
      }
    };
    const context: StepContext<State, Inputs> = {
      signal,
      get: () => {
        checkActive();
        return this.state;
      },
      update: (patch) => {
        checkActive();
        this.update(patch);
      },
      wait,
      ask: <Key extends keyof Inputs & string>(key: Key) => {
        checkActive();
        if (this.pending) throw new Error("A workflow step cannot ask two questions at once.");
        const answer = new Promise<Inputs[Key]>((resolve) => {
          this.pending = { key, answer: (value) => resolve(value as Inputs[Key]) };
        });
        this.update({ prompt: key });
        return wait(answer);
      },
      onCleanup: (cleanup) => signal.addEventListener("abort", cleanup, { once: true }),
    };
    this.update({ currentStep: step, prompt: undefined });
    void this.handlers[step](context)
      .then((result) => {
        if (signal.aborted) return;
        if (result.properties) {
          this.record(step, result.properties);
          const failedSteps = new Set(this.state.failedSteps);
          if (result.properties.status === "failed" && this.requiredSteps.includes(step)) failedSteps.add(step);
          this.update({
            completed: new Set([...this.state.completed, step]),
            results: { ...this.state.results, [step]: result.properties } as State["results"],
            failedSteps,
          });
        }
        if (result.next === "done") {
          this.dispose();
          this.update({ done: true, prompt: undefined, outcome: this.state.failedSteps.size ? "incomplete" : "ok" });
        } else this.run(result.next);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        this.dispose();
        this.record(step, { status: "failed" });
        this.update({
          failureSummary: error instanceof Error ? error.message : String(error),
          outcome: "error",
          prompt: undefined,
          results: { ...this.state.results, [step]: { status: "failed" } } as State["results"],
          failedSteps: new Set([...this.state.failedSteps, step]),
        });
      });
  }
}
