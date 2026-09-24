import { SmClient } from "../../products/syntheticMonitoring/api.js";
import { plan } from "../../products/syntheticMonitoring/reconcile.js";
import { writeCredentials } from "../../products/syntheticMonitoring/credentials.js";
import { aiEndpointCandidatesFor, candidatesFor } from "../../products/syntheticMonitoring/discover.js";
import { tryAlertingClient } from "../../products/syntheticMonitoring/notifications.js";
import { getSkillStatus, installSkill } from "../../skills.js";
import { tryAutoSmSession } from "../../products/syntheticMonitoring/smAuth.js";
import { writeTerraformExport } from "../../products/syntheticMonitoring/terraform.js";
import { commonServices } from "../workflow/services.js";

async function probeReachable(url: string): Promise<void> {
  // Any HTTP response proves reachability, even if this endpoint requires auth.
  await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((error: unknown) => {
    throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  });
}
export const syntheticsServices = {
  ...commonServices,
  buildPlan: plan,
  writeCredentials,
  aiEndpointCandidatesFor,
  candidatesFor,
  tryAlertingClient,
  getSkillStatus,
  installSkill,
  tryAutoSmSession,
  writeTerraformExport,
  probeReachable,
  createClient: (baseUrl: string, token: string) => new SmClient({ mode: "direct", baseUrl, token }),
};
export type SyntheticsServices = typeof syntheticsServices;
