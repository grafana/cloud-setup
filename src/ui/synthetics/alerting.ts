import { presetsFor } from "../../products/syntheticMonitoring/checkAlerts.js";
import {
  isEmailish,
  joinAddresses,
  parseAddresses,
  type AlertingClient,
  type AlertingInspection,
} from "../../products/syntheticMonitoring/notifications.js";
import type { StepProperties } from "../../telemetry.js";
import { MIN_SPINNER_MS } from "../shared.js";
import { applyCheckAlerts } from "./checkAlerts.js";
import { apiErrorMessage } from "./errors.js";
import type { AlertingDetail, SyntheticsContext, SyntheticsOptions } from "./model.js";
import type { SyntheticsServices } from "./services.js";

const NO_EMAIL_DETAIL = { text: "No email set. Alerts go to the stack's default contact point." };

function failedCheckAlerts(result: Awaited<ReturnType<typeof applyCheckAlerts>>): AlertingDetail {
  return {
    text: `Couldn't enable alerts on ${result.failed} check${result.failed === 1 ? "" : "s"}.`,
    error: result.firstError ?? "Alert configuration failed.",
  };
}

export async function configureAlerting(
  ctx: SyntheticsContext,
  services: SyntheticsServices,
  options: SyntheticsOptions,
): Promise<StepProperties> {
  const targets = ctx.get().items.filter((item) => item.id !== undefined);
  const presets = presetsFor(targets.map((item) => item.candidate)).map((preset) => preset.name);
  if (!ctx.get().session || !targets.length || !presets.length) return { status: "skipped" };
  const prior = ctx.get().alertingChoice;
  if (prior) {
    ctx.update({ alertingPhase: "applying" });
    const result = await applyCheckAlerts(ctx, targets, prior.presets);
    const failure = result.failed ? failedCheckAlerts(result) : undefined;
    const pending = ctx.get().pendingNextStepLog;
    if (pending)
      ctx.update({
        pendingNextStepLog: {
          ...pending,
          status: result.failed ? "failed" : "ok",
          detail: failure?.text ?? `Alerts enabled on ${result.alerted} more checks.`,
          error: failure?.error,
        },
      });
    return {
      status: result.failed ? "failed" : "ok",
      alerting_outcome: prior.outcome,
      alert_presets: prior.presets.length,
      checks_alerted: result.alerted,
    };
  }
  ctx.update({ alertingPhase: "confirm" });
  if (!(await ctx.ask("alerting"))) {
    ctx.update({ alertingChoice: { presets, outcome: "rules_only" }, alertingPhase: "applying" });
    const result = await applyCheckAlerts(ctx, targets, presets);
    ctx.update({
      alertingDetail: result.failed ? [failedCheckAlerts(result)] : [NO_EMAIL_DETAIL],
    });
    return {
      status: result.failed ? "failed" : "declined",
      alerting_outcome: "rules_only",
      alert_presets: presets.length,
      checks_alerted: result.alerted,
    };
  }
  let client: AlertingClient | undefined;
  let inspection: AlertingInspection | undefined;
  let inspectionFailure: AlertingDetail | undefined;
  const contactPointsUrl = `${options.stackUrl.replace(/\/$/, "")}/alerting/notifications`;
  if (!ctx.get().auth.error) {
    ctx.update({ alertingPhase: "inspecting" });
    const [candidate] = await ctx.wait(
      Promise.all([services.tryAlertingClient(options.stackUrl), services.sleep(MIN_SPINNER_MS)]),
    );
    if (candidate) {
      try {
        inspection = await ctx.wait(candidate.inspect());
        client = candidate;
      } catch (error) {
        ctx.signal.throwIfAborted();
        inspectionFailure = {
          text: "Couldn't read alerting contact points.",
          error: apiErrorMessage(error, "Permission denied to read alerting contact points."),
        };
      }
    }
  }
  let addresses: string | undefined;
  if (client && inspection) {
    ctx.update({
      emailInput: inspection.existingAddresses ?? inspection.userEmail ?? "",
      emailError: undefined,
    });
    for (;;) {
      ctx.update({ alertingPhase: "email-input" });
      const raw = await ctx.ask("email");
      const parsed = parseAddresses(raw);
      if (!parsed.length) break;
      const invalid = parsed.find((address) => !isEmailish(address));
      if (!invalid) {
        addresses = joinAddresses(parsed);
        break;
      }
      ctx.update({ emailInput: raw, emailError: `"${invalid}" doesn't look like an email address` });
    }
  }
  ctx.update({ alertingPhase: "applying" });
  const [result] = await ctx.wait(
    Promise.all([applyCheckAlerts(ctx, targets, presets), services.sleep(MIN_SPINNER_MS)]),
  );
  const detail: AlertingDetail[] = [];
  if (result.preserved) detail.push({ text: `${result.preserved} checks already had alerts, left as they were.` });
  if (result.failed) detail.push(failedCheckAlerts(result));
  let contactPoint: StepProperties["contact_point"];
  let notificationRoute: StepProperties["notification_route"];
  // Declined sign-in intentionally uses the stack's default routing. A failed
  // lookup after signing in means requested notification setup did not finish.
  let notificationsFailed = !ctx.get().auth.error && !client;
  if (client && addresses) {
    let configuringPolicy = false;
    try {
      contactPoint = await ctx.wait(client.ensureContactPoint(addresses));
      configuringPolicy = true;
      notificationRoute = await ctx.wait(client.ensureRoute());
      // No trailing period — right after an email address it reads as
      // part of it, same reason "Wrote to <path>" doesn't get one either.
      detail.push({ text: `Alerts go to ${parseAddresses(addresses).join(", ")}` });
    } catch (error) {
      ctx.signal.throwIfAborted();
      notificationsFailed = true;
      const resource = configuringPolicy ? "notification policies" : "alerting contact points";
      detail.push({
        text: `Couldn't configure ${resource}.`,
        error: apiErrorMessage(error, `Permission denied to manage ${resource}.`),
      });
    }
  } else
    detail.push(
      client
        ? NO_EMAIL_DETAIL
        : (inspectionFailure ??
            (notificationsFailed
              ? {
                  text: "Couldn't set an email.",
                  error: "Automatic email setup is unavailable. Add a contact point at",
                  href: contactPointsUrl,
                }
              : { text: "Couldn't set an email. Add a contact point at", href: contactPointsUrl })),
    );
  const outcome = !client ? "unavailable" : addresses && !notificationsFailed ? "configured" : "rules_only";
  ctx.update({ alertingDetail: detail, alertingChoice: { presets, outcome } });
  return {
    status: result.failed || notificationsFailed ? "failed" : "ok",
    alerting_outcome: outcome,
    alert_presets: presets.length,
    checks_alerted: result.alerted,
    contact_point: contactPoint,
    notification_route: notificationRoute,
  };
}
