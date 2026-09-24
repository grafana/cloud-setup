import { MIN_SPINNER_MS } from "../shared.js";
import type { StepProperties } from "../../telemetry.js";
import type { StepContext, WorkflowState } from "./controller.js";
import type { CommonServices } from "./services.js";

export interface CommonState {
  gcx: { subPhase: "checking-gcx" | "gcx-install-confirm" | "gcx-installing"; reinstalling: boolean; error?: string };
  auth: { subPhase: "browser-confirm" | "authenticating"; error?: string };
}
export interface CommonInputs {
  install: boolean;
  authenticate: boolean;
  abortAuth: boolean;
}
export const initialCommonState: CommonState = {
  gcx: { subPhase: "checking-gcx", reinstalling: false },
  auth: { subPhase: "browser-confirm" },
};

export async function runGcx<State extends WorkflowState & CommonState, Inputs extends CommonInputs>(
  ctx: StepContext<State, Inputs>,
  services: CommonServices,
  force: boolean,
): Promise<StepProperties> {
  services.checkNodeVersion();
  const alreadyInstalled = services.isGcxInstalled();
  ctx.update({ gcx: { subPhase: "checking-gcx", reinstalling: alreadyInstalled } } as Partial<State>);
  await ctx.wait(services.sleep(MIN_SPINNER_MS));
  if (!force && alreadyInstalled) return { status: "ok", already_installed: true, install_declined: false };
  ctx.update({ gcx: { subPhase: "gcx-install-confirm", reinstalling: alreadyInstalled } } as Partial<State>);
  const allow = await ctx.ask("install");
  if (!allow) return { status: "declined", already_installed: alreadyInstalled, install_declined: true };
  ctx.update({ gcx: { subPhase: "gcx-installing", reinstalling: alreadyInstalled } } as Partial<State>);
  try {
    await ctx.wait(Promise.all([services.installGcx(), services.sleep(MIN_SPINNER_MS)]));
    return { status: "ok", already_installed: alreadyInstalled, install_declined: false };
  } catch (error) {
    ctx.update({
      gcx: { ...ctx.get().gcx, error: error instanceof Error ? error.message : String(error) },
    } as Partial<State>);
    return { status: "failed", already_installed: alreadyInstalled, install_declined: false };
  }
}

export async function runAuth<State extends WorkflowState & CommonState, Inputs extends CommonInputs>(
  ctx: StepContext<State, Inputs>,
  services: CommonServices,
  stackUrl: string,
): Promise<StepProperties> {
  ctx.update({ auth: { subPhase: "browser-confirm" } } as Partial<State>);
  if (!(await ctx.ask("authenticate"))) {
    ctx.update({ auth: { subPhase: "browser-confirm", error: "declined" } } as Partial<State>);
    return { status: "declined", auth_outcome: "declined" };
  }
  ctx.update({ auth: { subPhase: "authenticating" } } as Partial<State>);
  const login = new AbortController();
  ctx.onCleanup(() => login.abort());
  try {
    const tokens = await ctx.wait(
      Promise.race([
        Promise.all([services.ensureAssistantAuth(stackUrl, login.signal), services.sleep(MIN_SPINNER_MS)]).then(
          ([tokens]) => tokens,
        ),
        ctx.ask("abortAuth").then(() => {
          login.abort();
          throw new Error("Sign-in cancelled");
        }),
      ]),
    );
    services.setStackIdentity(stackUrl, tokens.stackId);
    return { status: "ok", auth_outcome: "yes" };
  } catch (error) {
    ctx.update({
      auth: { subPhase: "authenticating", error: error instanceof Error ? error.message : String(error) },
    } as Partial<State>);
    const outcome = login.signal.aborted ? "aborted" : "failed";
    return { status: outcome, auth_outcome: outcome };
  }
}
