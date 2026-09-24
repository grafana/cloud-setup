import { useEffect, useState, useSyncExternalStore } from "react";
import type { HardExit } from "../shared.js";
import type { WorkflowController, WorkflowState } from "./controller.js";

// The only React lifecycle bridge needed by a wizard controller.
export function useWorkflow<State extends WorkflowState, Inputs extends object>(
  create: () => WorkflowController<State, Inputs>,
  exit: HardExit,
) {
  const [controller] = useState(create);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (state.failureSummary) exit(new Error(state.failureSummary));
    else if (state.done) exit(undefined, state.outcome);
  }, [state.done, state.failureSummary, state.outcome, exit]);
  return { controller, state };
}
