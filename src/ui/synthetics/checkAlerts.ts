import { alertsForCheck, type AlertPresetName } from "../../products/syntheticMonitoring/checkAlerts.js";
import { apiErrorMessage, SM_WRITE_DENIED } from "./errors.js";
import type { CreationItem, SyntheticsContext } from "./model.js";

export async function applyCheckAlerts(ctx: SyntheticsContext, targets: CreationItem[], presets: AlertPresetName[]) {
  let alerted = 0;
  let preserved = 0;
  let failed = 0;
  let firstError: string | undefined;
  const client = ctx.get().session!.client;
  for (const item of targets) {
    const alerts = alertsForCheck(item.candidate, presets);
    if (!alerts.length) continue;
    try {
      if (item.status === "skipped") {
        const existing = await ctx.wait(client.getCheckAlerts(item.id!));
        if (existing.length) {
          preserved++;
          continue;
        }
      }
      await ctx.wait(client.putCheckAlerts(item.id!, alerts));
      alerted++;
    } catch (error) {
      ctx.signal.throwIfAborted();
      failed++;
      firstError ??= apiErrorMessage(error, SM_WRITE_DENIED);
    }
  }
  return { alerted, preserved, failed, firstError };
}
