import { useInput } from "ink";
import type { HardExit } from "../shared.js";
import type { CommonInputs } from "./commonSteps.js";
import type { WorkflowController, WorkflowState } from "./controller.js";

// Text fields and menus own their keys. Global shortcuts must never eat text.
export function useWorkflowInput<State extends WorkflowState, Inputs extends CommonInputs>(
  controller: WorkflowController<State, Inputs>,
  state: State,
  exit: HardExit,
  textPrompts: readonly string[],
  answer: (input: string, key: { return: boolean; escape: boolean }) => void,
) {
  useInput((input, key) => {
    if (state.done || state.failureSummary) return;
    if (textPrompts.includes(state.prompt ?? "")) {
      if (key.escape) answer(input, key);
      return;
    }
    if (!state.started) {
      if (key.return || input.toLowerCase() === "y") controller.start();
      else if (["q", "n"].includes(input.toLowerCase())) exit("Cancelled.");
      return;
    }
    if (input.toLowerCase() === "q") {
      exit("Cancelled.");
      return;
    }
    const yes = key.return || input.toLowerCase() === "y";
    const no = input.toLowerCase() === "n";
    if (state.prompt === "install" && (yes || no)) controller.answer("install", yes);
    else if (state.prompt === "authenticate" && (yes || no)) controller.answer("authenticate", yes);
    else if (state.prompt === "abortAuth" && (no || key.escape)) controller.answer("abortAuth", true);
    else answer(input, key);
  });
}
