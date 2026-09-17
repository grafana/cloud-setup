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
import { SelectMenu, type SelectMenuItem } from "./SelectMenu.js";
import { accent, bad, EnterHint, Header, idColor, MIN_SPINNER_MS, muted, ok, startFakeProgress, useHardExit, Working } from "./shared.js";
import { useGcxStep } from "./steps/useGcxStep.js";
import { useAuthStep } from "./steps/useAuthStep.js";
import type { SyntheticConfig } from "../products/syntheticMonitoring/types.js";

const ANALYZE_MIN_MS = 5000;

// No real progress signal for a "browser-discovery" pass (an opaque
// discovery await, triggered on demand from the "next-steps" menu) — see
// shared.tsx's startFakeProgress for how this gets faked instead. The
// default "fast" mode (local candidate generation only) is quick enough
// not to need it.
const ANALYZE_PROGRESS_TARGET_MS = 60_000;
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
  // read from the existing check on a noop. Needed later by the "Export as
  // Terraform" next step to emit a working `terraform import` command for
  // each check.
  id?: number;
}

// The six macro-steps shown in the persistent step list. "create" covers
// reviewing candidates and creating them (see CreateSubPhase's "reviewing"
// phase) — its one checkmark row only lands once both are done, and `b`
// backs out of the connect/token sub-phases into "reviewing" rather than
// changing steps. "gcx", "auth", "skills", and "analyze" are fully
// automatic — once done, they stay done even if you navigate back past
// them, since there's nothing to reconfirm. "auth" signs in to Grafana
// Assistant once, up front — needed not just for AI-powered live endpoint
// discovery but also so "create"'s own auto-discovery (which reuses this
// same OAuth session to reach the Synthetic Monitoring API) never pops an
// unannounced browser window later. "analyze" covers local candidate
// generation for the fast/default path — live browser discovery and
// Terraform export move behind "next-steps" instead of blocking the common
// case, and only run on-demand when explicitly chosen there (which
// re-enters "analyze" with a different mode — see AnalyzeMode below — then
// routes back through "create" before returning to the menu). Frontend
// Observability instrumentation is a separate concern, not chained onto
// this flow — see the standalone `frontend` subcommand (FrontendApp.tsx).
type StepId = "gcx" | "auth" | "skills" | "analyze" | "create" | "next-steps";

const STEP_ORDER: StepId[] = ["gcx", "auth", "skills", "analyze", "create", "next-steps"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Install Grafana Cloud CLI (gcx)",
  auth: "Authenticate with OAuth",
  skills: "Configure skills",
  analyze: "Analyze target",
  create: "Create Synthetic Checks",
  "next-steps": "Next steps",
};

// "fast" (the default, first pass): local candidate generation only — no
// browser, no confirms (sign-in already happened, or was declined, in the
// top-level "auth" step long before this ever runs). "browser-discovery":
// only ever entered on-demand, by picking it from the "next-steps" menu —
// checks auth.error up front (no re-prompting — "auth" only ever runs
// once), runs live endpoint discovery, appends any new candidates, and
// routes back through "create" to the menu — see runAnalyze below.
type AnalyzeMode = "fast" | "browser-discovery";

// "analyzing" covers the "fast" mode; "discovering" is "browser-discovery"
// — picking it from the menu is its own confirmation, so there's no
// secondary y/n here.
type AnalyzeSubPhase = "analyzing" | "discovering";

// "next-steps": a repeatable menu shown after "create" finishes (and after
// every subsequent "browser-discovery" pass routes back through "create").
// Picking "Discover live endpoints via browser" jumps back to "analyze";
// picking "Export as Terraform" runs inline (see runExportNow) without
// leaving the menu — picking a menu option IS its own confirmation, so
// none of these ask a further y/n. Not shown as its own row in StepsList —
// completed picks append their own row instead (see nextStepsLog).
type NextStepsSubPhase = "menu" | "exporting";

const NEXT_STEP_OPTIONS: SelectMenuItem[] = [
  { key: "browser-discovery", label: "Discover live endpoints via browser" },
  { key: "export", label: "Export as Terraform" },
  { key: "exit", label: "Nothing else — I'm done" },
];

// Reused as-is for both the dynamic "in progress" row in StepsList (while
// a pick runs — see runAnalyze) and its final logged entry (see
// pendingNextStepLog/runExportNow) — a neutral, present-tense label that
// never implies success on its own, same as "Authenticate with OAuth"
// stays neutral whether accepted or declined. The outcome (found N,
// nothing new, failed, wrote to path, ...) is always the log entry's own
// `detail` line instead.
function nextStepOptionLabel(key: string): string {
  return NEXT_STEP_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

// A pick disappears from the menu once it's logged as done, regardless of
// outcome — "exit" is always offered. Once nothing else is left, the menu
// never renders at all (see runNextSteps) — this only decides what CAN
// still show.
function availableNextStepOptions(log: { key: string }[]): SelectMenuItem[] {
  const used = new Set(log.map((e) => e.key));
  return NEXT_STEP_OPTIONS.filter((o) => o.key === "exit" || !used.has(o.key));
}

// "create": "reviewing" is the checkbox-list selection UI (formerly its own
// step); `b` from any later sub-phase except "creating" returns here.
// Connecting to the SM API and authenticating with a token lives here (not
// in "gcx") since it's unrelated to the gcx CLI — it only needs to happen
// once, so a revisit via back-navigation, or a later pass triggered from
// "next-steps", skips straight to "creating" once `session` is populated.
type CreateSubPhase = "reviewing" | "auto-discovering" | "base-url-input" | "connecting" | "token-input" | "validating" | "creating";

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
  const [analyzeMode, setAnalyzeMode] = useState<AnalyzeMode>("fast");
  const [analyzeSubPhase, setAnalyzeSubPhase] = useState<AnalyzeSubPhase>("analyzing");
  const [analyzeProgress, setAnalyzeProgress] = useState(0);

  // gcx/auth steps — shared with FrontendApp via src/ui/steps. "auth" runs
  // once, automatically, right after "gcx" — declining or failing it just
  // means "Discover live endpoints via browser" skips itself later (see
  // runAnalyze's auth.error check), never re-prompting.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep(
    "Sign in to Grafana Cloud to enable AI-powered endpoint suggestions? This will open a browser.",
    currentStep === "auth"
  );

  // create step — "reviewing"'s selectedKeys seeded once (in runAnalyze),
  // then kept live via CheckboxList's onSelectionChange so a back-then-
  // forward round trip restores the user's actual choices instead of
  // resetting to defaults.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [createSubPhase, setCreateSubPhase] = useState<CreateSubPhase>("reviewing");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [connectError, setConnectError] = useState<string>();
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string>();
  const [tokenPageUrl, setTokenPageUrl] = useState<string>();
  const [assignedProbes, setAssignedProbes] = useState<string[]>([]);
  // Items for whichever "create" pass is currently running or most
  // recently ran — always what the in-progress/live row (fixed on the
  // first, "fast" pass; the dynamic next-steps row on every later pass)
  // shows. `firstPassItems` is a permanent snapshot of the first pass only
  // (mirrored during it — see runCreate), so the fixed "Create Synthetic
  // Checks" row's own nested list never changes once a later pass starts
  // overwriting `items` for itself.
  const [items, setItems] = useState<CreationItem[]>([]);
  const [firstPassItems, setFirstPassItems] = useState<CreationItem[]>([]);
  // Accumulates the final item list from every later (non-"fast") create
  // pass that actually ran, for the done-screen summary — `items` alone
  // can't be trusted there: a next-steps pick that finds nothing new never
  // runs a create pass at all (see runAnalyze/backToNextSteps), leaving
  // `items` stale from an earlier pass and double-counting it if summed
  // in naively.
  const [extraCreatedItems, setExtraCreatedItems] = useState<CreationItem[]>([]);

  // next-steps menu
  const [nextStepsSubPhase, setNextStepsSubPhase] = useState<NextStepsSubPhase>("menu");
  // A one-line status shown at the top of the menu after a pass that
  // produced nothing new, or couldn't run at all (e.g. sign-in declined,
  // export failed) — cleared whenever a new next-step action starts.
  const [nextStepsNotice, setNextStepsNotice] = useState<string>();
  // One entry per completed next-step pick, rendered as its own checkmark
  // row in StepsList (below the fixed steps) — see runExportNow and
  // pendingNextStepLog below. `key` matches a NEXT_STEP_OPTIONS key, and is
  // used to drop that option from the menu once it's done (see
  // availableNextStepOptions). Also doubles as "have we done anything yet"
  // for whether NextStepsBody shows its one-time intro line. `detail`, if
  // set, renders as its own muted line under the checkmark (same pattern
  // as "auth"'s declined-sign-in note) rather than crowding the main line.
  const [nextStepsLog, setNextStepsLog] = useState<{ key: string; label: string; detail?: string }[]>([]);

  const session = useRef<Session>(undefined as unknown as Session);
  // The exact config the latest "create" pass built (target/probes/settings
  // /frequency per check) — kept here rather than recomputed, so "Export as
  // Terraform" emits Terraform for precisely what was actually created, not
  // a re-derived guess. Always reflects the full currently-selected set
  // (old + any newly discovered candidates still checked), since each
  // "create" pass rebuilds it from every currently-selected candidate.
  const createdConfigRef = useRef<SyntheticConfig>({});
  const baseUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
  const tokenResolver = useRef<((token: string) => void) | undefined>(undefined);
  const selectResolver = useRef<((keys: string[]) => void) | undefined>(undefined);
  // Set by runAnalyze for every "browser-discovery" outcome (found
  // something, found nothing, or failed) — consumed once "next-steps" is
  // reached again (see runNextSteps), appending it to nextStepsLog.
  const pendingNextStepLog = useRef<{ key: string; label: string; detail?: string } | undefined>(undefined);

  const isWaiting =
    (currentStep === "gcx" && gcx.isWaiting) ||
    (currentStep === "auth" && auth.isWaiting) ||
    (currentStep === "create" &&
      (createSubPhase === "reviewing" || createSubPhase === "base-url-input" || createSubPhase === "token-input"));
  // "reviewing" has nowhere earlier to go back to within this step, and
  // "creating" is already mutating remote state — everything in between
  // (connect/token entry) can still back out to "reviewing".
  const backAllowed = currentStep === "create" && createSubPhase !== "reviewing" && createSubPhase !== "creating";

  function goBack() {
    if (backAllowed) setCreateSubPhase("reviewing");
  }

  function advance() {
    setCompleted((prev) => new Set(prev).add(currentStep));
    const idx = STEP_ORDER.indexOf(currentStep);
    const next = STEP_ORDER[idx + 1];
    if (next) setCurrentStep(next);
  }

  // Used at the end of a "browser-discovery" analyze pass (instead of
  // advance()) — "analyze"/"create" stay completed (checkmarked) from the
  // first, "fast" pass onward and are never uncompleted again, so this
  // just moves on to "create" without touching StepsList's fixed rows at
  // all; the dynamic next-steps row (see StepsList) is what shows this
  // pass's own progress instead.
  function proceedToReview() {
    setCurrentStep("create");
  }

  // Used when a "browser-discovery" pass can't produce anything (sign-in
  // declined/failed) — still marks "analyze" done (it did run) and returns
  // straight to the menu rather than continuing into "create" with nothing
  // new.
  function backToNextSteps(notice?: string) {
    if (notice) setNextStepsNotice(notice);
    setCurrentStep("next-steps");
  }

  // Entry point for the "next-steps" menu's "Discover live endpoints"
  // option — jumps back to "analyze" (already checkmarked from the first
  // pass, and staying that way — see proceedToReview).
  function runNextStepChoice(mode: AnalyzeMode) {
    setNextStepsNotice(undefined);
    // `items` is left over from whichever pass last ran one — the dynamic
    // row's nested list (see StepsList) would otherwise show that stale
    // result for however long this pass takes before its own runCreate,
    // if it even gets that far, overwrites it.
    setItems([]);
    setAnalyzeMode(mode);
    setCurrentStep("analyze");
  }

  function finishNextSteps() {
    advance();
    setDone(true);
  }

  function handleNextStepChoice(key: string) {
    if (key === "exit") finishNextSteps();
    else if (key === "export") runExportNow();
    else runNextStepChoice(key as AnalyzeMode);
  }

  // Runs "Export as Terraform" inline from the next-steps menu — the menu
  // pick itself is the confirmation, so this fires immediately rather than
  // asking a further y/n. Independent of the step-driving effect below
  // (currentStep stays "next-steps" throughout, so nothing else needs to
  // react to it running).
  async function runExportNow() {
    setNextStepsSubPhase("exporting");
    // job name -> the SM check ID the API assigned, for the README's
    // `terraform import` commands.
    const remoteIds = new Map(items.filter((it) => it.id !== undefined).map((it) => [it.candidate.label, it.id!]));
    // Logged either way (see the label/detail comment above
    // pendingNextStepLog) — a failed export is still done attempting, not
    // left retryable in the menu.
    let detail: string;
    try {
      const [writtenPath] = await Promise.all([
        writeTerraformExport(createdConfigRef.current, session.current.probes, remoteIds, initialStackUrl, session.current.url, process.cwd()),
        sleep(MIN_SPINNER_MS),
      ]);
      detail = `Wrote to ${path.relative(process.cwd(), writtenPath)}`;
    } catch (err) {
      detail = `Couldn't export (${err instanceof Error ? err.message : String(err)})`;
    }
    setNextStepsLog((prev) => [...prev, { key: "export", label: nextStepOptionLabel("export"), detail }]);
    // Whether there's actually anything left to offer is handled
    // reactively, below — this never has to know or care.
    setNextStepsSubPhase("menu");
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

  // CheckboxList isn't rendered at all when there's nothing new to select
  // (see SelectBody) — its own Enter-to-submit handler goes with it, so
  // this covers that case directly.
  useInput(
    (input, key) => {
      if (key.return) selectResolver.current?.([]);
    },
    { isActive: currentStep === "create" && createSubPhase === "reviewing" && (candidates?.length ?? 0) === 0 }
  );

  // SelectMenu (rendered by NextStepsBody) owns arrow/Enter navigation —
  // this only adds Esc as a shortcut for its own "exit" option, same as
  // useAuthStep's cancel keybind.
  useInput(
    (input, key) => {
      if (key.escape) finishNextSteps();
    },
    { isActive: currentStep === "next-steps" && nextStepsSubPhase === "menu" }
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

    async function runAuth() {
      await auth.run(initialStackUrl, () => cancelled);
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
      const mode = analyzeMode;
      const targetUrl = /^https?:\/\//.test(initialTargetUrl) ? initialTargetUrl : `https://${initialTargetUrl}`;

      if (mode === "fast") {
        setAnalyzeSubPhase("analyzing");
        setAnalyzeProgress(0);
        const [list] = await Promise.all([candidatesFor(targetUrl), sleep(ANALYZE_MIN_MS)]);
        if (cancelled) return;
        setCandidates(list);
        setSelectedKeys(list.filter((c) => c.selectedByDefault).map((c) => c.key));
        advance();
        return;
      }

      // The top-level "auth" step already asked once, right after "gcx" —
      // declined or failed there means this skips itself here, same as if
      // it were declined right now, never re-prompting.
      if (auth.error) {
        backToNextSteps(`Grafana Assistant isn't signed in (${auth.error}) — skipped.`);
        return;
      }

      setAnalyzeProgress(0);
      const progress = startFakeProgress(setAnalyzeProgress, () => cancelled, ANALYZE_PROGRESS_TARGET_MS);
      setAnalyzeSubPhase("discovering");
      try {
        // Picking this option from the next-steps menu was already the
        // confirmation — the harness's own gate is a pass-through here,
        // not a second ask.
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
          pendingNextStepLog.current = {
            key: "browser-discovery",
            label: nextStepOptionLabel("browser-discovery"),
            detail: `${aiCandidates.length} new check${aiCandidates.length === 1 ? "" : "s"} found`,
          };
        } else {
          // Nothing new — logged as done (see the label/detail comment
          // above pendingNextStepLog) rather than re-entering "create" to
          // review/re-touch the same candidates all over again for no
          // reason.
          pendingNextStepLog.current = {
            key: "browser-discovery",
            label: nextStepOptionLabel("browser-discovery"),
            detail: "No additional live endpoints discovered.",
          };
          progress.stop();
          backToNextSteps();
          return;
        }
      } catch {
        // Nice-to-have — never blocks setup on a failed discovery pass.
        pendingNextStepLog.current = {
          key: "browser-discovery",
          label: nextStepOptionLabel("browser-discovery"),
          detail: "Couldn't discover live endpoints.",
        };
        progress.stop();
        backToNextSteps();
        return;
      }

      if (cancelled) {
        progress.stop();
        return;
      }
      await progress.finish();
      if (cancelled) return;
      proceedToReview();
    }

    async function runCreate() {
      setCreateSubPhase("reviewing");
      const chosen = await new Promise<string[]>((resolve) => {
        selectResolver.current = resolve;
      });
      if (cancelled) return;
      setSelectedKeys(chosen);

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

      // `chosen`, not the `selectedKeys` state — this closure was created
      // once, when "create" became current, and setSelectedKeys(chosen)
      // above doesn't retroactively update the value it captured then, so
      // reading the state here would silently use whatever was selected
      // by default instead of what was actually just submitted.
      const selected = (candidates ?? []).filter((c) => chosen.includes(c.key));
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
      // Mirrored into a permanent snapshot only for the first, "fast"
      // pass — see the `items`/`firstPassItems` state comment — so the
      // fixed "Create Synthetic Checks" row's own nested list is frozen
      // once a later next-steps pass starts overwriting `items` for itself.
      if (analyzeMode === "fast") setFirstPassItems(workingItems);

      const updateItem = (key: string, patch: Partial<CreationItem>) => {
        workingItems = workingItems.map((it) => (it.candidate.key === key ? { ...it, ...patch } : it));
        setItems(workingItems);
        if (analyzeMode === "fast") setFirstPassItems(workingItems);
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
      if (analyzeMode !== "fast") setExtraCreatedItems((prev) => [...prev, ...workingItems]);
      advance();
    }

    async function runNextSteps() {
      // Captured into a plain local first, and only then cleared — the
      // updater below runs later, not synchronously, so reading the ref
      // itself inside it would just as often see the `undefined` this
      // clears it to a line down as the entry meant to be appended.
      const pending = pendingNextStepLog.current;
      pendingNextStepLog.current = undefined;
      if (pending) {
        setNextStepsLog((prev) => [...prev, pending]);
      }
      // Nothing else to await here — the menu is driven entirely by
      // SelectMenu's own input handling and the dedicated Esc handler
      // above (picking an option either navigates away via setCurrentStep,
      // or runs inline via runExportNow). Whether there's actually
      // anything left to offer is handled reactively, below.
      setNextStepsSubPhase("menu");
    }

    async function run() {
      try {
        if (currentStep === "gcx") await runGcx();
        else if (currentStep === "auth") await runAuth();
        else if (currentStep === "skills") await runSkills();
        else if (currentStep === "analyze") await runAnalyze();
        else if (currentStep === "create") await runCreate();
        else if (currentStep === "next-steps") await runNextSteps();
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
  // Reacts to nextStepsLog itself rather than being called explicitly by
  // every place that appends to it (runNextSteps, runExportNow, and any
  // future next-step action) — so a pick that finishes without ever
  // leaving "next-steps" (like export) can't skip this check the way a
  // one-off inline call would if a future action forgot to make it.
  useEffect(() => {
    if (
      currentStep === "next-steps" &&
      nextStepsSubPhase === "menu" &&
      availableNextStepOptions(nextStepsLog).every((o) => o.key === "exit")
    ) {
      finishNextSteps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextStepsLog, currentStep, nextStepsSubPhase]);

  // Shared by the fixed "current" row and the dynamic next-steps row below
  // — frozen (not animated) while individual checks are creating, or while
  // waiting on input; that's where the moving per-check spinner lives now.
  function liveIcon() {
    return isWaiting || (currentStep === "create" && createSubPhase === "creating") ? (
      <Text color={accent}>●</Text>
    ) : (
      <Text color={accent}>
        <Spinner type="dots" />
      </Text>
    );
  }

  function StepsList() {
    return (
      <Box flexDirection="column">
        {STEP_ORDER.filter((step) => step !== "next-steps").map((step) => {
          // Completed wins over "current" — matters for the last visible
          // step ("create"), which stays completed forever once the first
          // pass finishes (a later next-steps pass re-enters "analyze"/
          // "create" without ever uncompleting them — see proceedToReview
          // — so its own progress shows on the dynamic row below instead,
          // never by flipping this row back to a spinner).
          let row;
          if (completed.has(step)) {
            row = (
              <Text>
                {" "}
                <Text color={ok}>✓</Text> {STEP_LABELS[step]}
              </Text>
            );
          } else if (step === currentStep) {
            row = (
              <Text>
                {" "}
                {liveIcon()} <Text bold>{STEP_LABELS[step]}</Text>
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
          // than as a separate section below the whole list. Always
          // `firstPassItems` (frozen after the first pass), never the
          // live `items` a later pass reuses for itself.
          return (
            <Box key={step} flexDirection="column">
              {row}
              {step === "create" && firstPassItems.length > 0 && (
                <Box flexDirection="column">{ItemsList(firstPassItems)}</Box>
              )}
              {step === "auth" && completed.has(step) && auth.error && (
                <Text color={muted}>{"     "}Skipping AI-powered suggestions ({auth.error})</Text>
              )}
            </Box>
          );
        })}
        {nextStepsLog.map((entry, i) => (
          <Box key={`next-steps-log-${i}`} flexDirection="column">
            <Text>
              {" "}
              <Text color={ok}>✓</Text> {entry.label}
            </Text>
            {entry.detail && <Text color={muted}>{"     "}{entry.detail}</Text>}
          </Box>
        ))}
        {analyzeMode !== "fast" && currentStep !== "next-steps" && (
          <Box flexDirection="column">
            <Text>
              {" "}
              {liveIcon()} <Text bold>{nextStepOptionLabel(analyzeMode)}</Text>
              {currentStep === "analyze" && <Text color={muted}> — {analyzeProgress}%</Text>}
            </Text>
            {items.length > 0 && <Box flexDirection="column">{ItemsList(items)}</Box>}
          </Box>
        )}
      </Box>
    );
  }

  function Footer() {
    // Nothing to toggle/move when there's no selectable list at all —
    // SelectBody already shows its own EnterHint for that case.
    if (currentStep !== "create" || createSubPhase !== "reviewing" || (candidates?.length ?? 0) === 0) return null;
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
    if (analyzeSubPhase === "discovering") return <Working label="Opening a browser to discover live endpoints…" />;
    return null;
  }

  function NextStepsBody() {
    if (nextStepsSubPhase === "exporting") return <Working label="Exporting as Terraform…" />;
    return (
      <Box flexDirection="column">
        {nextStepsLog.length === 0 && <Text>Nice — the basics are set up.</Text>}
        {nextStepsNotice && <Text color={muted}>{nextStepsNotice}</Text>}
        <Text>Want to do anything else?</Text>
        <SelectMenu items={availableNextStepOptions(nextStepsLog)} accentColor={accent ?? "white"} onSelect={handleNextStepChoice} />
        <Box marginTop={1}>
          <Text color={muted}>↑↓ move   ⏎ select   Esc to stop</Text>
        </Box>
      </Box>
    );
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
  function ItemsList(list: CreationItem[]) {
    const loadZones = assignedProbes.join(", ");
    return list.map((it) => (
      <Text key={it.candidate.key}>
        {"     "}
        <ItemIcon status={it.status} /> {it.candidate.title}
        {loadZones && <Text> — {loadZones}</Text>}
        {it.detail ? <Text color={muted}> — {it.detail}</Text> : null}
      </Text>
    ));
  }

  function CreateBody() {
    if (createSubPhase === "reviewing") return SelectBody();
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
    const allItems = [...firstPassItems, ...extraCreatedItems];
    const createdCount = allItems.filter((it) => it.status === "created").length;
    const updatedCount = allItems.filter((it) => it.status === "updated").length;
    const skippedCount = allItems.filter((it) => it.status === "skipped").length;
    const summaryParts = [
      createdCount > 0 ? `${createdCount} created` : "",
      updatedCount > 0 ? `${updatedCount} updated` : "",
      skippedCount > 0 ? `${skippedCount} already up to date` : "",
    ].filter(Boolean);
    const summarySentence =
      summaryParts.length > 0
        ? `${allItems.length} check${allItems.length === 1 ? "" : "s"}: ${summaryParts.join(", ")}`
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
          (currentStep === "create" && createSubPhase !== "connecting" && createSubPhase !== "auto-discovering") ||
          (currentStep === "gcx" && gcx.subPhase === "gcx-install-confirm") ||
          (currentStep === "auth" && auth.subPhase === "browser-confirm") ||
          (currentStep === "analyze" && analyzeSubPhase === "discovering") ||
          currentStep === "next-steps"
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
            {currentStep === "create" && CreateBody()}
            {currentStep === "next-steps" && NextStepsBody()}
          </>
        )}
      </Box>
      {!failureSummary && Footer()}
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={muted}>Resolve the issue, then run `npx @grafana/cloud-setup` again.</Text>
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
