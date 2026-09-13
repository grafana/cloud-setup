import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { SmApiError, SmClient, type Probe } from "../products/syntheticMonitoring/api.js";
import { plan as buildPlan } from "../products/syntheticMonitoring/reconcile.js";
import { writeCredentials } from "../products/syntheticMonitoring/credentials.js";
import { aiEndpointCandidatesFor, candidatesFor, type Candidate } from "../products/syntheticMonitoring/discover.js";
import { getSkillStatus, installSkill } from "../skills.js";
import { tryAutoSmSession } from "../products/syntheticMonitoring/smAuth.js";
import { writeTerraformExport } from "../products/syntheticMonitoring/terraform.js";
import { CheckboxList } from "./CheckboxList.js";
import { accent, bad, EnterHint, Header, idColor, MIN_SPINNER_MS, muted, ok, useHardExit, Working } from "./shared.js";
import { useGcxStep } from "./steps/useGcxStep.js";
import { useAuthStep } from "./steps/useAuthStep.js";
import type { SyntheticConfig } from "../products/syntheticMonitoring/types.js";

const ANALYZE_MIN_MS = 5000;

// Purely decorative — there's no real progress signal to show across the
// whole "Analyze target" step (local generation, the confirm question,
// then one opaque discovery await), so this fakes one, paced against a
// wall-clock target rather than random step sizes so it reads as roughly
// "on schedule" instead of jittery. Real work almost always finishes
// before that target — finish() is the deliberate "speed up" for when it
// does, sprinting the number up to 100 instead of letting it jump there.
const ANALYZE_PROGRESS_TARGET_MS = 60_000;

interface FakeProgress {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  finish: () => Promise<void>;
}

function startFakeProgress(onProgress: (percent: number) => void, isCancelled: () => boolean): FakeProgress {
  const startedAt = Date.now();
  // Time spent paused doesn't count toward elapsed — otherwise resuming
  // after, say, a slow answer to the browser-confirm question would jump
  // the number ahead to "catch up" to real elapsed time, which is exactly
  // the jump this is meant to avoid.
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
    const paced = (elapsed / ANALYZE_PROGRESS_TARGET_MS) * 100 + (Math.random() * 4 - 2);
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
// This step lands right after "sign in"'s own real-world wait (the OAuth
// browser flow) — a bare MIN_SPINNER_MS here reads as an abrupt jump cut
// right after that, rather than a natural next step.
const SKILLS_MIN_MS = 4500;

// Any HTTP response at all (even 401/404) proves the host is real and
// speaking HTTP; only a network-level failure means the URL is bad. Not
// authenticated — just enough to make "Connecting…" a real check.
async function probeReachable(url: string): Promise<void> {
  await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((err) => {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function formatFrequency(ms: number): string {
  const seconds = ms / 1000;
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

type ItemStatus = "pending" | "running" | "created" | "updated" | "skipped" | "failed";

function ItemIcon({ status }: { status: ItemStatus }) {
  if (status === "created" || status === "updated") return <Text color={ok}>✓</Text>;
  if (status === "failed") return <Text color={bad}>✖</Text>;
  if (status === "skipped") return <Text color={muted}>=</Text>;
  if (status === "running")
    return (
      <Text color={accent}>
        <Spinner type="dots" />
      </Text>
    );
  return <Text color={muted}>○</Text>;
}

interface CreationItem {
  candidate: Candidate;
  status: ItemStatus;
  detail?: string;
  // The SM check ID the API assigned — populated once created/updated, or
  // read from the existing check on a noop. Needed later by "export" to
  // emit a working `terraform import` command for each check.
  id?: number;
}

// The seven macro-steps shown in the persistent step list. "select"/"create"
// are editable (can be a `b` back-navigation target); "gcx", "skills",
// "analyze", "auth", and "export" are fully automatic — once done, they
// stay done even if you navigate back past them, since there's nothing to
// reconfirm. "analyze" covers both local candidate generation and (if
// authenticated) AI-powered live endpoint discovery — one step, not two.
// Frontend O11y instrumentation is a separate concern, not chained onto
// this flow — see the standalone `frontend` subcommand (FrontendApp.tsx).
type StepId = "gcx" | "skills" | "analyze" | "auth" | "select" | "create" | "export";

const STEP_ORDER: StepId[] = ["gcx", "auth", "skills", "analyze", "select", "create", "export"];
const EDITABLE_STEPS: StepId[] = ["select", "create"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  skills: "Configure skills",
  analyze: "Analyze target",
  auth: "Authenticate with OAuth",
  select: "Review Synthetic Checks",
  create: "Create Synthetic Checks",
  export: "Export Synthetic Checks as Terraform",
};

function previousEditableStep(from: StepId): StepId | undefined {
  const idx = STEP_ORDER.indexOf(from);
  for (let i = idx - 1; i >= 0; i--) {
    if (EDITABLE_STEPS.includes(STEP_ORDER[i])) return STEP_ORDER[i];
  }
  return undefined;
}

// "analyze": runs local candidate generation first (no confirmation
// needed), then — unless "auth" already failed — asks once whether it's OK
// to open a real (visible, not headless) browser against the target URL
// for AI-powered live endpoint discovery. Declining just leaves only the
// standard candidates.
type AnalyzeSubPhase = "analyzing" | "browser-confirm" | "discovering";
const ANALYZE_WAITING_SUBPHASES: AnalyzeSubPhase[] = ["browser-confirm"];

// "export": ask once, up front, whether to write a Terraform export of the
// checks just created — declining just ends the wizard, same as a failed
// export would.
type ExportSubPhase = "export-confirm" | "exporting";
const EXPORT_WAITING_SUBPHASES: ExportSubPhase[] = ["export-confirm"];

// "create": connecting to the SM API and authenticating with a token lives
// here (not in "gcx") since it's unrelated to the gcx CLI — it only needs to
// happen once, so a revisit via back-navigation skips straight to "creating"
// once `session` is populated.
type CreateSubPhase = "auto-discovering" | "base-url-input" | "connecting" | "token-input" | "validating" | "creating";

interface Session {
  // Display/export only (e.g. the Terraform export's sm_url) — never used
  // to build requests; proxy-mode sessions don't need a real SM API URL.
  url?: string;
  client: SmClient;
  probes: Probe[];
}

interface Props {
  initialBaseUrl?: string;
  initialTargetUrl: string;
  initialStackUrl: string;
  forceGcxInstall: boolean;
}

export function SetupApp({ initialBaseUrl, initialTargetUrl, initialStackUrl, forceGcxInstall }: Props) {
  const exit = useHardExit();

  const [started, setStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("gcx");
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [done, setDone] = useState(false);
  const [failureSummary, setFailureSummary] = useState<string>();

  // analyze step
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [analyzeSubPhase, setAnalyzeSubPhase] = useState<AnalyzeSubPhase>("analyzing");
  const [analyzeProgress, setAnalyzeProgress] = useState(0);

  // gcx/auth steps — shared with FrontendApp via src/ui/steps.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep(
    "Sign in to Grafana Cloud to enable AI-powered endpoint suggestions? This will open a browser.",
    currentStep === "auth"
  );

  // select step — seeded once (in runAnalyze), then kept live via
  // CheckboxList's onSelectionChange so a back-then-forward round trip
  // restores the user's actual choices instead of resetting to defaults.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // create step
  const [createSubPhase, setCreateSubPhase] = useState<CreateSubPhase>("auto-discovering");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [connectError, setConnectError] = useState<string>();
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string>();
  const [tokenPageUrl, setTokenPageUrl] = useState<string>();
  const [assignedProbes, setAssignedProbes] = useState<string[]>([]);
  const [items, setItems] = useState<CreationItem[]>([]);

  // export step — a set "error" just means the export didn't happen, but
  // the real reason is still shown rather than swallowed.
  const [exportSubPhase, setExportSubPhase] = useState<ExportSubPhase>("export-confirm");
  const [exportPath, setExportPath] = useState<string>();
  const [exportError, setExportError] = useState<string>();

  const session = useRef<Session>(undefined as unknown as Session);
  // The exact config "create" built (target/probes/settings/frequency per
  // check) — kept here rather than recomputed, so "export" emits Terraform
  // for precisely what was actually created, not a re-derived guess.
  const createdConfigRef = useRef<SyntheticConfig>({});
  const baseUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
  const tokenResolver = useRef<((token: string) => void) | undefined>(undefined);
  const selectResolver = useRef<((keys: string[]) => void) | undefined>(undefined);
  const browserPermissionResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  const exportPermissionResolver = useRef<((allow: boolean) => void) | undefined>(undefined);

  const backTarget = previousEditableStep(currentStep);
  const isWaiting =
    (currentStep === "gcx" && gcx.isWaiting) ||
    (currentStep === "auth" && auth.isWaiting) ||
    (currentStep === "analyze" && ANALYZE_WAITING_SUBPHASES.includes(analyzeSubPhase)) ||
    (currentStep === "export" && EXPORT_WAITING_SUBPHASES.includes(exportSubPhase)) ||
    currentStep === "select" ||
    (currentStep === "create" && (createSubPhase === "base-url-input" || createSubPhase === "token-input"));
  const backAllowed =
    backTarget !== undefined && (currentStep === "select" || (currentStep === "create" && createSubPhase !== "creating"));

  function goBack() {
    const target = previousEditableStep(currentStep);
    if (!target) return;
    setCompleted((prev) => {
      const next = new Set(prev);
      const targetIndex = STEP_ORDER.indexOf(target);
      for (const s of EDITABLE_STEPS) {
        if (STEP_ORDER.indexOf(s) >= targetIndex) next.delete(s);
      }
      return next;
    });
    setCurrentStep(target);
  }

  function advance() {
    setCompleted((prev) => new Set(prev).add(currentStep));
    const idx = STEP_ORDER.indexOf(currentStep);
    const next = STEP_ORDER[idx + 1];
    if (next) setCurrentStep(next);
  }

  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") setStarted(true);
      else if (input.toLowerCase() === "n") exit("Cancelled.");
    },
    { isActive: !started }
  );

  // Quit is disabled while free text is being typed (a token or URL could
  // legitimately contain the letter q) — Ctrl+C still works there.
  const quittingBlocked = currentStep === "create" && (createSubPhase === "base-url-input" || createSubPhase === "token-input");
  useInput(
    (input) => {
      if (input.toLowerCase() === "q") exit("Cancelled.");
    },
    { isActive: !quittingBlocked }
  );
  useInput(
    (input) => {
      if (input.toLowerCase() === "b") goBack();
    },
    { isActive: backAllowed }
  );

  useInput(
    (input, key) => {
      if (currentStep === "analyze" && analyzeSubPhase === "browser-confirm") {
        if (key.return || input.toLowerCase() === "y") browserPermissionResolver.current?.(true);
        else if (input.toLowerCase() === "n") browserPermissionResolver.current?.(false);
      }
    },
    { isActive: currentStep === "analyze" && analyzeSubPhase === "browser-confirm" }
  );

  useInput(
    (input, key) => {
      if (currentStep === "export" && exportSubPhase === "export-confirm") {
        if (key.return || input.toLowerCase() === "y") exportPermissionResolver.current?.(true);
        else if (input.toLowerCase() === "n") exportPermissionResolver.current?.(false);
      }
    },
    { isActive: currentStep === "export" && exportSubPhase === "export-confirm" }
  );

  // Drives whichever step is current. Re-runs whenever currentStep changes —
  // including on back-navigation, since the effect cleanup (`cancelled`)
  // orphans the previous step's in-flight promise harmlessly (it's just
  // awaiting a resolver that will now never be called). Does nothing until
  // the user confirms the initial "proceed?" prompt.
  useEffect(() => {
    if (!started) return;
    let cancelled = false;

    async function runGcx() {
      await gcx.run(() => cancelled);
      if (cancelled) return;
      advance();
    }

    async function runSkills() {
      try {
        await Promise.all([
          (async () => {
            const status = await getSkillStatus();
            if (!status.installed) await installSkill();
          })(),
          sleep(SKILLS_MIN_MS),
        ]);
      } catch {
        // Non-fatal — this is a nice-to-have for agent tooling, not core to creating checks.
      }
      if (cancelled) return;
      advance();
    }

    async function runAnalyze() {
      // Starts right away — before we even know whether the browser step
      // will run — so the percent is already moving during local
      // generation and the confirm question, not just once discovery
      // itself starts.
      setAnalyzeSubPhase("analyzing");
      setAnalyzeProgress(0);
      const progress = startFakeProgress(setAnalyzeProgress, () => cancelled);

      const targetUrl = /^https?:\/\//.test(initialTargetUrl) ? initialTargetUrl : `https://${initialTargetUrl}`;
      const [list] = await Promise.all([candidatesFor(targetUrl), sleep(ANALYZE_MIN_MS)]);
      if (cancelled) {
        progress.stop();
        return;
      }
      setCandidates(list);
      setSelectedKeys(list.filter((c) => c.selectedByDefault).map((c) => c.key));

      // No point asking to open a browser for live discovery if there's no
      // signed-in assistant to judge what it finds — skip straight through,
      // same as if the user had declined.
      if (auth.error) {
        await progress.finish();
        if (cancelled) return;
        advance();
        return;
      }

      setAnalyzeSubPhase("browser-confirm");
      // Paused for the question itself — how long you take to answer
      // shouldn't count against the pace, or the number would leap ahead
      // to "catch up" the moment you do.
      progress.pause();
      const allow = await new Promise<boolean>((resolve) => {
        browserPermissionResolver.current = resolve;
      });
      progress.resume();
      if (cancelled) {
        progress.stop();
        return;
      }

      if (allow) {
        setAnalyzeSubPhase("discovering");
        try {
          // Permission was already granted above via this step's own
          // prompt — the harness's own gate is a pass-through here, not a
          // second ask.
          const [aiCandidates] = await Promise.all([
            aiEndpointCandidatesFor(targetUrl, initialStackUrl, () => true),
            sleep(MIN_SPINNER_MS),
          ]);
          if (cancelled) {
            progress.stop();
            return;
          }
          if (aiCandidates.length > 0) {
            setCandidates((prev) => [...(prev ?? []), ...aiCandidates]);
          }
        } catch {
          // Nice-to-have — never blocks setup on a failed discovery pass.
        }
      }
      if (cancelled) {
        progress.stop();
        return;
      }
      await progress.finish();
      if (cancelled) return;
      advance();
    }

    async function runAuth() {
      await auth.run(initialStackUrl, () => cancelled);
      if (cancelled) return;
      advance();
    }

    async function runSelect() {
      const chosen = await new Promise<string[]>((resolve) => {
        selectResolver.current = resolve;
      });
      if (cancelled) return;
      setSelectedKeys(chosen);
      advance();
    }

    async function runCreate() {
      if (!session.current) {
        // Try reusing the "Authenticate with OAuth" session through
        // Grafana's own datasource-proxy route before ever asking for a
        // base URL or a pasted access token — no prompt shown at all when
        // this works. Any failure (insufficient role, SM not provisioned
        // as a datasource on this stack, ...) just falls through to the
        // manual flow below, unchanged.
        setCreateSubPhase("auto-discovering");
        const [auto] = await Promise.all([tryAutoSmSession(initialStackUrl), sleep(MIN_SPINNER_MS)]);
        if (cancelled) return;
        if (auto) {
          session.current = { url: auto.apiUrl, client: auto.client, probes: auto.probes };
        } else {
          setCreateSubPhase("base-url-input");
        }
      }

      if (!session.current) {
        const pageUrl = `${initialStackUrl.replace(/\/$/, "")}/a/grafana-synthetic-monitoring-app/config/access-tokens`;
        setTokenPageUrl(pageUrl);

        let candidateUrl = baseUrl;
        for (;;) {
          if (!candidateUrl) {
            setCreateSubPhase("base-url-input");
            candidateUrl = await new Promise<string>((resolve) => {
              baseUrlResolver.current = resolve;
            });
            setBaseUrl(candidateUrl);
          }
          if (cancelled) return;

          setCreateSubPhase("connecting");
          try {
            await Promise.all([probeReachable(candidateUrl), sleep(MIN_SPINNER_MS)]);
            break;
          } catch (err) {
            setConnectError(err instanceof Error ? err.message : String(err));
            candidateUrl = undefined;
            setBaseUrl(undefined);
          }
        }
        if (cancelled) return;
        const url = candidateUrl;

        let client: SmClient = undefined as unknown as SmClient;
        let probes: Probe[] = [];
        for (;;) {
          setCreateSubPhase("token-input");
          const token = await new Promise<string>((resolve) => {
            tokenResolver.current = resolve;
          });
          if (cancelled) return;
          setCreateSubPhase("validating");
          await sleep(400);
          const candidateClient = new SmClient({ mode: "direct", baseUrl: url, token });
          try {
            probes = await candidateClient.listProbes();
            client = candidateClient;
            await writeCredentials({ baseUrl: url, token, stackUrl: initialStackUrl, email: undefined });
            session.current = { url, client, probes };
            break;
          } catch (err) {
            setTokenError(err instanceof Error ? err.message : String(err));
            setTokenInput("");
          }
        }
        if (cancelled) return;
      }

      setCreateSubPhase("creating");

      const selected = (candidates ?? []).filter((c) => selectedKeys.includes(c.key));
      const probeNames = session.current.probes.slice(0, 2).map((p) => p.name);
      if (probeNames.length === 0) throw new Error("No probes are available on this tenant.");
      setAssignedProbes(probeNames);

      const config: SyntheticConfig = {};
      for (const c of selected) {
        config[c.label] = { target: c.target, probes: probeNames, settings: c.settings, frequency: c.frequencyMs };
      }
      createdConfigRef.current = config;

      let workingItems: CreationItem[] = selected.map((candidate) => ({ candidate, status: "pending" as ItemStatus }));
      setItems(workingItems);

      const updateItem = (key: string, patch: Partial<CreationItem>) => {
        workingItems = workingItems.map((it) => (it.candidate.key === key ? { ...it, ...patch } : it));
        setItems(workingItems);
      };

      const planResult = await buildPlan(config, session.current.client);

      for (const action of planResult.actions) {
        const candidate = selected.find((c) => c.label === action.name);
        if (!candidate) continue;

        // Every check gets the same minimum-spinner treatment, including
        // ones already up to date — going one by one consistently rather
        // than instantly flashing "skipped".
        updateItem(candidate.key, { status: "running" });
        if (action.kind === "noop") {
          await sleep(MIN_SPINNER_MS);
          updateItem(candidate.key, { status: "skipped", detail: "already up to date", id: action.id });
          continue;
        }
        try {
          const [remote] = await Promise.all([
            action.kind === "create" ? session.current.client.createCheck(action.payload) : session.current.client.updateCheck(action.payload),
            sleep(MIN_SPINNER_MS),
          ]);
          const status: ItemStatus = action.kind === "create" ? "created" : "updated";
          updateItem(candidate.key, { status, id: remote.id });
        } catch (err) {
          const detail = err instanceof SmApiError ? err.body : err instanceof Error ? err.message : String(err);
          updateItem(candidate.key, { status: "failed", detail });
        }
      }
      if (cancelled) return;

      const failed = workingItems.find((it) => it.status === "failed");
      if (failed) {
        const createdCount = workingItems.filter((it) => it.status === "created" || it.status === "updated").length;
        throw new Error(
          `${createdCount} of ${workingItems.length} check${workingItems.length === 1 ? "" : "s"} was created.\n\n` +
            `Could not create ${failed.candidate.title}: ${failed.detail}`
        );
      }
      advance();
    }

    async function runExport() {
      setExportSubPhase("export-confirm");
      setExportError(undefined);
      setExportPath(undefined);
      const allow = await new Promise<boolean>((resolve) => {
        exportPermissionResolver.current = resolve;
      });
      if (cancelled) return;

      if (allow) {
        setExportSubPhase("exporting");
        // job name -> the SM check ID the API assigned, for the README's
        // `terraform import` commands.
        const remoteIds = new Map(items.filter((it) => it.id !== undefined).map((it) => [it.candidate.label, it.id!]));
        try {
          const [writtenPath] = await Promise.all([
            writeTerraformExport(createdConfigRef.current, session.current.probes, remoteIds, initialStackUrl, session.current.url, process.cwd()),
            sleep(MIN_SPINNER_MS),
          ]);
          if (cancelled) return;
          setExportPath(path.relative(process.cwd(), writtenPath));
        } catch (err) {
          if (cancelled) return;
          setExportError(err instanceof Error ? err.message : String(err));
        }
      }
      if (cancelled) return;
      advance();
      setDone(true);
    }

    async function run() {
      try {
        if (currentStep === "gcx") await runGcx();
        else if (currentStep === "skills") await runSkills();
        else if (currentStep === "analyze") await runAnalyze();
        else if (currentStep === "auth") await runAuth();
        else if (currentStep === "select") await runSelect();
        else if (currentStep === "create") await runCreate();
        else if (currentStep === "export") await runExport();
      } catch (err) {
        if (cancelled) return;
        setFailureSummary(err instanceof Error ? err.message : String(err));
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, started]);

  useEffect(() => {
    if (done) exit();
  }, [done, exit]);
  useEffect(() => {
    if (failureSummary) exit(new Error(failureSummary));
  }, [failureSummary, exit]);

  function StepsList() {
    return (
      <Box flexDirection="column">
        {STEP_ORDER.map((step) => {
          // Completed wins over "current" — matters for the last step
          // ("create"), which stays `currentStep` forever once done (there's
          // no next step to advance into), so without this it would keep
          // showing a spinner even after everything finished.
          let row;
          if (completed.has(step)) {
            // analyzeProgress is guaranteed 100 by the time this step is
            // marked completed (advance() only runs after progress.finish()
            // resolves) — keep showing it rather than dropping the number
            // the moment the checkmark appears.
            const suffix = step === "analyze" ? analyzeStatusSuffix() : undefined;
            row = (
              <Text>
                {" "}
                <Text color={ok}>✓</Text> {STEP_LABELS[step]}
                {suffix && <Text color={muted}> — {suffix}</Text>}
              </Text>
            );
          } else if (step === currentStep) {
            // Frozen (not animated) while individual checks are creating —
            // that's where the moving spinner lives now, one at a time.
            const icon =
              isWaiting || (step === "create" && createSubPhase === "creating") ? (
                <Text color={accent}>●</Text>
              ) : (
                <Text color={accent}>
                  <Spinner type="dots" />
                </Text>
              );
            const suffix = step === "analyze" ? analyzeStatusSuffix() : undefined;
            row = (
              <Text>
                {" "}
                {icon} <Text bold>{STEP_LABELS[step]}</Text>
                {suffix && <Text color={muted}> — {suffix}</Text>}
              </Text>
            );
          } else {
            row = (
              <Text color={muted}>
                {" "}· {STEP_LABELS[step]}
              </Text>
            );
          }

          // The checks themselves live nested under their own step, rather
          // than as a separate section below the whole list.
          return (
            <Box key={step} flexDirection="column">
              {row}
              {step === "create" && items.length > 0 && <Box flexDirection="column">{ItemsList()}</Box>}
              {step === "auth" && completed.has(step) && auth.error && (
                <Text color={muted}> Skipping AI-powered suggestions ({auth.error})</Text>
              )}
              {step === "export" && completed.has(step) && exportPath && <Text>{"     "}Wrote {exportPath}</Text>}
              {step === "export" && completed.has(step) && exportError && (
                <Text color={muted}>{"     "}Skipped Terraform export ({exportError})</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  function Footer() {
    if (currentStep !== "select") return null;
    // No marginTop here on purpose — the blank line above the prompt
    // already comes from the Box wrapping it in the main render; hints sit
    // directly beneath the prompt they describe, with no gap. "continue"
    // gets its own line via EnterHint, same as everywhere else it appears,
    // rather than being crammed onto the navigation-hint line.
    return (
      <Box flexDirection="column">
        <Text color={muted}>space toggle   ↑↓ move</Text>
        <EnterHint />
      </Box>
    );
  }

  function AnalyzeBody() {
    if (analyzeSubPhase === "browser-confirm")
      return (
        <Box flexDirection="column">
          <Text>
            Open a real browser to see which live endpoints <Text color={idColor}>{initialTargetUrl}</Text> actually
            calls?
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    return null;
  }

  function ExportBody() {
    if (exportSubPhase === "export-confirm")
      return (
        <Box flexDirection="column">
          <Text>Export these checks as Terraform too?</Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    return null;
  }

  function SelectBody() {
    if (!candidates) return null;
    return (
      <Box flexDirection="column">
        <Text>These are the Synthetic Checks we suggest creating</Text>
        <CheckboxList
          items={candidates.map((c) => ({
            key: c.key,
            label: c.title,
            description: c.description,
            meta: `(${formatFrequency(c.frequencyMs)})`,
          }))}
          initialSelected={new Set(selectedKeys)}
          accentColor={accent ?? "white"}
          onSubmit={(keys) => selectResolver.current?.(keys)}
          onSelectionChange={setSelectedKeys}
        />
        <Box marginTop={1}>
          <Text color={muted}>
            {selectedKeys.length} check{selectedKeys.length === 1 ? "" : "s"} selected
          </Text>
        </Box>
      </Box>
    );
  }

  // Shared between the live "creating" progress view and the final done
  // screen, which keeps showing the same list rather than swapping it out
  // for a plain summary once finished.
  function ItemsList() {
    const loadZones = assignedProbes.join(", ");
    return items.map((it) => (
      <Text key={it.candidate.key}>
        {"     "}
        <ItemIcon status={it.status} /> {it.candidate.title}
        {loadZones && <Text> — {loadZones}</Text>}
        {it.detail ? <Text color={muted}> — {it.detail}</Text> : null}
      </Text>
    ));
  }

  function CreateBody() {
    // No body here — the step list's own spinner next to "Create Synthetic
    // Checks" already shows something's happening; a second "Checking…"
    // line just flashes in and out with nothing to say once it's gone.
    if (createSubPhase === "auto-discovering") return null;
    if (createSubPhase === "base-url-input")
      return (
        <Box flexDirection="column">
          {connectError && <Text color={bad}>{connectError}</Text>}
          <Box>
            <Text>Synthetic Monitoring API URL: </Text>
            <TextInput
              value={baseUrlInput}
              onChange={setBaseUrlInput}
              onSubmit={(v) => baseUrlResolver.current?.(v.trim().replace(/\/$/, ""))}
            />
          </Box>
        </Box>
      );
    if (createSubPhase === "connecting") return null;
    if (createSubPhase === "token-input")
      return (
        <Box flexDirection="column">
          {tokenError && <Text color={bad}>{tokenError}</Text>}
          <Text>Last thing, we promise. Enter your Grafana Cloud access token</Text>
          {tokenPageUrl && (
            <Text color={muted}>
              Generate one here: <Text color="blue">{tokenPageUrl}</Text>
            </Text>
          )}
          <Box>
            <Text>Token: </Text>
            <TextInput
              value={tokenInput}
              onChange={setTokenInput}
              onSubmit={(v) => tokenResolver.current?.(v.trim())}
              mask="*"
            />
          </Box>
        </Box>
      );
    if (createSubPhase === "validating") return <Working label="Validating access token…" />;
    return null; // "creating" — the checks render nested under the step row in StepsList instead.
  }

  // Purely decorative — the step list otherwise just sits on "Analyze
  // target" with a spinner for up to a real minute (local generation, the
  // confirm question, then a live browser pass) with nothing to show for
  // it. A fake percent (see startFakeProgress) reads cleaner here than a
  // string of status words, and runs for the step's whole duration rather
  // than only once discovery itself starts.
  function analyzeStatusSuffix(): string {
    return `${analyzeProgress}%`;
  }

  if (!started) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        <Text>
          Let's set up synthetic checks for <Text color={idColor}>{initialTargetUrl}</Text>
        </Text>
        <EnterHint />
      </Box>
    );
  }

  if (done) {
    const createdCount = items.filter((it) => it.status === "created").length;
    const updatedCount = items.filter((it) => it.status === "updated").length;
    const skippedCount = items.filter((it) => it.status === "skipped").length;
    const summaryParts = [
      createdCount > 0 ? `${createdCount} created` : "",
      updatedCount > 0 ? `${updatedCount} updated` : "",
      skippedCount > 0 ? `${skippedCount} already up to date` : "",
    ].filter(Boolean);
    const summarySentence =
      summaryParts.length > 0
        ? `${items.length} check${items.length === 1 ? "" : "s"}: ${summaryParts.join(", ")}`
        : "nothing to do";

    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        {StepsList()}
        <Box marginTop={1} flexDirection="column">
          <Text bold>Cool, we're done! {summarySentence}.</Text>
          <Text color={muted}>
            See them here: <Text color="blue">{initialStackUrl.replace(/\/$/, "")}/a/grafana-synthetic-monitoring-app/checks</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Header stackUrl={initialStackUrl} />
      {StepsList()}
      <Box
        marginTop={
          failureSummary ||
          currentStep === "select" ||
          (currentStep === "create" && createSubPhase !== "connecting" && createSubPhase !== "auto-discovering") ||
          (currentStep === "gcx" && gcx.subPhase === "gcx-install-confirm") ||
          (currentStep === "auth" && auth.subPhase === "browser-confirm") ||
          (currentStep === "analyze" && analyzeSubPhase === "browser-confirm") ||
          (currentStep === "export" && exportSubPhase === "export-confirm")
            ? 1
            : 0
        }
        flexDirection="column"
      >
        {failureSummary ? (
          <Text color={bad} bold>
            Setup incomplete. {failureSummary}
          </Text>
        ) : (
          <>
            {currentStep === "gcx" && gcx.body}
            {currentStep === "auth" && auth.body}
            {currentStep === "analyze" && AnalyzeBody()}
            {currentStep === "select" && SelectBody()}
            {currentStep === "create" && CreateBody()}
            {currentStep === "export" && ExportBody()}
          </>
        )}
      </Box>
      {!failureSummary && Footer()}
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={muted}>Resolve the issue, then run `npx @grafana/setup-cli` again.</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runSetupUI(
  initialBaseUrl: string | undefined,
  initialTargetUrl: string,
  initialStackUrl: string,
  forceGcxInstall: boolean
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("synthetics requires an interactive terminal.");
  }
  // exitOnCtrlC disabled — Ink's own default Ctrl+C handling runs before
  // useHardExit's useInput callback ever gets a turn (both listen on the
  // same stdin stream, and Ink's own listener wins the race), so it kills
  // the process first and our "Cancelled." message never prints. Letting
  // useHardExit be the only Ctrl+C handler avoids that race entirely.
  const app = render(
    <SetupApp
      initialBaseUrl={initialBaseUrl}
      initialTargetUrl={initialTargetUrl}
      initialStackUrl={initialStackUrl}
      forceGcxInstall={forceGcxInstall}
    />,
    { exitOnCtrlC: false }
  );
  await app.waitUntilExit();
}
