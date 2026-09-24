import { MIN_SPINNER_MS } from "../shared.js";
import type { SyntheticsContext, SyntheticsOptions, Session } from "./model.js";
import type { SyntheticsServices } from "./services.js";

export async function connect(
  ctx: SyntheticsContext,
  services: SyntheticsServices,
  options: SyntheticsOptions,
): Promise<Session> {
  const existing = ctx.get().session;
  if (existing) return existing;
  if (!ctx.get().auth.error) {
    ctx.update({ createPhase: "auto-discovering" });
    const [auto] = await ctx.wait(
      Promise.all([services.tryAutoSmSession(options.stackUrl), services.sleep(MIN_SPINNER_MS)]),
    );
    if (auto) {
      const session = { url: auto.apiUrl, client: auto.client, probes: auto.probes };
      ctx.update({ session });
      return session;
    }
  }
  let candidateUrl = ctx.get().baseUrl;
  for (;;) {
    if (!candidateUrl) {
      ctx.update({ createPhase: "base-url-input" });
      candidateUrl = (await ctx.ask("baseUrl")).trim().replace(/\/$/, "");
      ctx.update({ baseUrl: candidateUrl, connectError: undefined });
    }
    ctx.update({ createPhase: "connecting" });
    try {
      await ctx.wait(Promise.all([services.probeReachable(candidateUrl), services.sleep(MIN_SPINNER_MS)]));
      break;
    } catch (error) {
      ctx.update({ connectError: error instanceof Error ? error.message : String(error), baseUrl: undefined });
      candidateUrl = undefined;
    }
  }
  const url = candidateUrl;
  for (;;) {
    ctx.update({ createPhase: "token-input" });
    const token = (await ctx.ask("token")).trim();
    ctx.update({ createPhase: "validating", tokenError: undefined });
    await ctx.wait(services.sleep(400));
    const client = services.createClient(url, token);
    try {
      const probes = await ctx.wait(client.listProbes());
      await ctx.wait(services.writeCredentials({ baseUrl: url, token, stackUrl: options.stackUrl, email: undefined }));
      const session = { url, client, probes };
      ctx.update({ session });
      return session;
    } catch (error) {
      ctx.update({ tokenError: error instanceof Error ? error.message : String(error) });
    }
  }
}
