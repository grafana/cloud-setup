import { setTimeout as sleep } from "node:timers/promises";
import { ensureAssistantAuth } from "../../harness/index.js";
import { installGcx, isGcxInstalled } from "../../gcx.js";
import { setStackIdentity } from "../../telemetry.js";
import { checkNodeVersion } from "../shared.js";
import { startFakeProgress } from "./progress.js";

// The environment boundary is injected into controllers for offline tests.
export const commonServices = {
  sleep,
  startFakeProgress,
  checkNodeVersion,
  installGcx,
  isGcxInstalled,
  ensureAssistantAuth,
  setStackIdentity,
};
export type CommonServices = typeof commonServices;
