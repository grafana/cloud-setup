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
import { accent, bad, EnterHint, Header, MIN_SPINNER_MS, muted, ok, startFakeProgress, url, useHardExit, Working } from "./shared.js";
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
// How long the fake-percentage meter (paced against
// ANALYZE_PROGRESS_TARGET_MS, so this lands around 10%) climbs on its own
// right when "Find additional synthetic checks" is picked, before the
// browser-confirm question ever shows — reads as a quick pre-check rather
// than the question popping up the instant the menu item is picked.
const PRE_DISCOVERY_CHECK_MS = ANALYZE_PROGRESS_TARGET_MS / 10;
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

// One entry per completed next-step pick, rendered as its own row below
// the fixed steps in StepsList. `items`, when set, nests the checks that
// pick actually created underneath it (same ItemIcon/ItemsList look as
// "Create synthetic checks") instead of a plain text `detail` line — see
// runCreate for where a "browser-discovery" pass fills this in once it
// knows what was actually created, overriding the provisional "N found"
// entry runAnalyze logs first.
interface NextStepLogEntry {
  key: string;
  label: string;
  detail?: string;
  items?: CreationItem[];
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
  create: "Create synthetic checks",
  "next-steps": "Next steps",
};

// "fast" (the default, first pass): local candidate generation only — no
// browser, no confirms (sign-in already happened, or was declined, in the
// top-level "auth" step long before this ever runs). "browser-discovery":
// only ever entered on-demand, by picking it from the "next-steps" menu —
// checks auth.error up front (no re-prompting — "auth" only ever runs
// once), asks its own separate y/n before actually opening a browser (see
// "browser-confirm" below), then runs live endpoint discovery, appends any
// new candidates, and routes back through "create" to the menu — see
// runAnalyze below.
type AnalyzeMode = "fast" | "browser-discovery";

// "analyzing" covers the "fast" mode (no confirm — see AnalyzeMode).
// "browser-discovery" is the only mode that ever reaches "browser-confirm"
// or "discovering": picking it from the "next-steps" menu isn't itself the
// confirmation — a real browser is enough of a surprise to warrant its own
// explicit y/n, same as the top-level "auth" step's.
type AnalyzeSubPhase = "analyzing" | "browser-confirm" | "discovering";

// "next-steps": a repeatable menu shown after "create" finishes (and after
// every subsequent "browser-discovery" pass routes back through "create").
// Picking "Find additional synthetic checks" jumps back to "analyze" to ask
// its own y/n before it does anything (see AnalyzeSubPhase); picking
// "Export checks as Terraform" runs inline (see runExportNow) without
// leaving the menu, and IS its own confirmation (no further y/n) since it
// never opens a browser. Not shown as its own row in StepsList — completed
// picks (including a declined "Find additional synthetic checks") append
// their own row instead (see nextStepsLog).
type NextStepsSubPhase = "menu" | "exporting";

// No "Finish"/"exit" entry — there's nothing left to pick once every one
// of these is used, and the menu quietly finishes itself then (see
// availableNextStepOptions and the auto-finish effect below). Leaving
// early before that happens is 'q' (see the global quit keybind), the
// same key that works everywhere else in this wizard.
const NEXT_STEP_OPTIONS: SelectMenuItem[] = [
  { key: "browser-discovery", label: "Find additional synthetic checks" },
  { key: "export", label: "Export checks as Terraform" },
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
// outcome. Once nothing's left, this returns empty — see the auto-finish
// effect below, which is what actually ends the menu at that point.
function availableNextStepOptions(log: { key: string }[]): SelectMenuItem[] {
  const used = new Set(log.map((e) => e.key));
  return NEXT_STEP_OPTIONS.filter((o) => !used.has(o.key));
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
  // once, automatically, right after "gcx", and backs two separate things:
  // "Find additional synthetic checks" (skips itself later — see
  // runAnalyze's auth.error check) AND "create"'s own auto-discovery of
  // Synthetic Monitoring access (skips straight to the manual base-url/
  // token flow instead — see runCreate's auth.error check). Declining or
  // failing it here never re-prompts; both of those just fall back on
  // their own.
  const gcx = useGcxStep(forceGcxInstall, currentStep === "gcx");
  const auth = useAuthStep("Sign in to Grafana Cloud using your browser?", currentStep === "auth");

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
  // row in StepsList (below the fixed steps) — see runExportNow,
  // pendingNextStepLog below, and NextStepLogEntry. `key` matches a
  // NEXT_STEP_OPTIONS key, and is used to drop that option from the menu
  // once it's done (see availableNextStepOptions). Also doubles as "have
  // we done anything yet" for whether NextStepsBody shows its one-time
  // intro line.
  const [nextStepsLog, setNextStepsLog] = useState<NextStepLogEntry[]>([]);

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
  // "browser-discovery"'s own y/n before it actually opens a browser — see
  // AnalyzeSubPhase's "browser-confirm".
  const browserPermissionResolver = useRef<((allow: boolean) => void) | undefined>(undefined);
  // Set by runAnalyze for every "browser-discovery" outcome (found
  // something, found nothing, declined, or failed) — consumed once
  // "next-steps" is reached again (see runNextSteps), appending it to
  // nextStepsLog.
  const pendingNextStepLog = useRef<NextStepLogEntry | undefined>(undefined);

  const isWaiting =
    (currentStep === "gcx" && gcx.isWaiting) ||
    (currentStep === "auth" && auth.isWaiting) ||
    (currentStep === "analyze" && analyzeSubPhase === "browser-confirm") ||
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

  // Entry point for the "next-steps" menu's "Find additional Synthetic
  // Checks" option — jumps back to "analyze" (already checkmarked from
  // the first pass, and staying that way — see proceedToReview).
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
    if (key === "export") runExportNow();
    else runNextStepChoice(key as AnalyzeMode);
  }

  // Runs "Export checks as Terraform" inline from the next-steps menu —
  // the menu pick itself is the confirmation, so this fires immediately
  // rather than asking a further y/n. Independent of the step-driving
  // effect below (currentStep stays "next-steps" throughout, so nothing
  // else needs to react to it running).
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
      if (input.toLowerCase() !== "q") return;
      // At the next-steps menu, 'q' IS "I'm done" — there's no "Finish"
      // entry to pick instead (see NEXT_STEP_OPTIONS) — so this finishes
      // the same graceful way an exhausted menu does on its own, rather
      // than exiting through the generic "Cancelled." path everywhere
      // else 'q' means bailing out early.
      if (currentStep === "next-steps" && nextStepsSubPhase === "menu") finishNextSteps();
      else exit("Cancelled.");
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

  // "browser-discovery"'s own y/n before opening a browser — same
  // shape as useAuthStep's own cancel keybind.
  useInput(
    (input, key) => {
      if (key.return || input.toLowerCase() === "y") browserPermissionResolver.current?.(true);
      else if (input.toLowerCase() === "n") browserPermissionResolver.current?.(false);
    },
    { isActive: currentStep === "analyze" && analyzeSubPhase === "browser-confirm" }
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

      // One continuous fake-percentage meter for the whole pass, same
      // shape as main's original "analyze" step: climbs on its own for a
      // bit (see PRE_DISCOVERY_CHECK_MS) before the confirm even shows,
      // then pauses for the question itself — how long you take to
      // answer shouldn't count against the pace, or the number would
      // leap ahead to "catch up" the moment you do — then resumes and
      // keeps climbing through the real discovery work below, rather
      // than resetting to 0 at either point. "analyzing" isn't a new
      // subphase: nothing renders for it beyond the dynamic StepsList
      // row's own live percentage, same as "discovering".
      setAnalyzeSubPhase("analyzing");
      setAnalyzeProgress(0);
      const progress = startFakeProgress(setAnalyzeProgress, () => cancelled, ANALYZE_PROGRESS_TARGET_MS);
      await sleep(PRE_DISCOVERY_CHECK_MS);
      if (cancelled) {
        progress.stop();
        return;
      }

      // Picking "Find additional synthetic checks" from the menu isn't
      // itself the confirmation — a real browser opening is enough of a
      // surprise to warrant its own explicit y/n, same as the top-level
      // "auth" step's. A decline here is logged and done, same as every
      // other outcome (see the pendingNextStepLog comment above its ref)
      // rather than re-prompted.
      setAnalyzeSubPhase("browser-confirm");
      progress.pause();
      const allowBrowser = await new Promise<boolean>((resolve) => {
        browserPermissionResolver.current = resolve;
      });
      progress.resume();
      if (cancelled) {
        progress.stop();
        return;
      }
      if (!allowBrowser) {
        progress.stop();
        pendingNextStepLog.current = {
          key: "browser-discovery",
          label: nextStepOptionLabel("browser-discovery"),
          detail: "Skipped — no browser opened.",
        };
        backToNextSteps();
        return;
      }

      setAnalyzeSubPhase("discovering");
      try {
        // The explicit y/n above was the confirmation — the harness's own
        // gate is a pass-through here, not a second ask.
        const [aiCandidates] = await Promise.all([
          aiEndpointCandidatesFor(targetUrl, initialStackUrl, () => true),
          sleep(MIN_SPINNER_MS),
        ]);
        if (cancelled) {
          progress.stop();
          return;
        }
        // Excludes anything a previous pass already created/updated/
        // skipped — the AI judge has no memory of that, so without this a
        // rediscovered endpoint would clutter the review screen with a
        // check that's already live (see handledCandidateKeys/SelectBody).
        const handled = handledCandidateKeys();
        const newCandidates = aiCandidates.filter((c) => !handled.has(c.key));
        if (newCandidates.length > 0) {
          setCandidates((prev) => [...(prev ?? []), ...newCandidates]);
          pendingNextStepLog.current = {
            key: "browser-discovery",
            label: nextStepOptionLabel("browser-discovery"),
            detail: `${newCandidates.length} new check${newCandidates.length === 1 ? "" : "s"} found`,
          };
        } else {
          // Nothing new — logged as done (see the label/detail comment
          // above pendingNextStepLog) rather than re-entering "create" to
          // review/re-touch the same candidates all over again for no
          // reason.
          pendingNextStepLog.current = {
            key: "browser-discovery",
            label: nextStepOptionLabel("browser-discovery"),
            detail: "No new endpoints found.",
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
          detail: "Couldn't discover additional endpoints.",
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
        // this works. Only attempted if that session actually exists:
        // ensureAssistantAuth has no memory of an earlier decline or
        // failure and would otherwise happily retry the full interactive
        // login right here, popping a second, unannounced browser window
        // moments after the user already said no (or hit a real failure)
        // at the top-level "auth" step. Either way, no session here just
        // falls through to the manual base-url/token flow below.
        if (!auth.error) {
          setCreateSubPhase("auto-discovering");
          const [auto] = await Promise.all([tryAutoSmSession(initialStackUrl), sleep(MIN_SPINNER_MS)]);
          if (cancelled) return;
          if (auto) session.current = { url: auto.apiUrl, client: auto.client, probes: auto.probes };
        }
        if (!session.current) setCreateSubPhase("base-url-input");
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
      // by default instead of what was actually just submitted. Also
      // drops anything an earlier pass already created/updated/skipped —
      // `chosen` can still contain those (CheckboxList's own selection
      // carries forward keys hidden from the review screen too, see
      // SelectBody), but re-running `plan` for them here would mean this
      // pass re-checking (as a harmless but pointless noop) every check
      // from every prior pass, on top of whatever's actually new.
      const handledKeys = handledCandidateKeys();
      const selected = (candidates ?? []).filter((c) => chosen.includes(c.key) && !handledKeys.has(c.key));
      const probeNames = session.current.probes.slice(0, 2).map((p) => p.name);
      if (probeNames.length === 0) throw new Error("No probes are available on this tenant.");
      setAssignedProbes(probeNames);

      const config: SyntheticConfig = {};
      for (const c of selected) {
        config[c.label] = { target: c.target, probes: probeNames, settings: c.settings, frequency: c.frequencyMs };
      }
      // Merged, not replaced — `plan` above only ever runs against this
      // pass's own (now filtered-down) `config`, so the entries from
      // every earlier pass have to be carried forward here for "Export
      // checks as Terraform" to still emit all of them, not just the
      // latest pass's.
      createdConfigRef.current = { ...createdConfigRef.current, ...config };

      let workingItems: CreationItem[] = selected.map((candidate) => ({ candidate, status: "pending" as ItemStatus }));
      setItems(workingItems);
      // Mirrored into a permanent snapshot only for the first, "fast"
      // pass — see the `items`/`firstPassItems` state comment — so the
      // fixed "Create synthetic checks" row's own nested list is frozen
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
        // ones that already exist — going one by one consistently rather
        // than instantly flashing "skipped".
        updateItem(candidate.key, { status: "running" });
        if (action.kind === "noop") {
          await sleep(MIN_SPINNER_MS);
          updateItem(candidate.key, { status: "skipped", detail: "already exists", id: action.id });
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
      // `workingItems` is already just this pass's own new candidates —
      // `selected` excludes anything handledCandidateKeys() already covers
      // (see its filter above) — so nothing here needs to be re-deduped
      // against firstPassItems/extraCreatedItems.
      if (analyzeMode !== "fast") {
        setExtraCreatedItems((prev) => [...prev, ...workingItems]);
        // Overrides the provisional "N found" entry runAnalyze logged
        // before this pass ever ran — this is the definitive outcome, so
        // the checklist row gets the actual created checks nested under
        // it (see NextStepLogEntry), not just a found-count blurb.
        pendingNextStepLog.current =
          workingItems.length > 0
            ? { key: "browser-discovery", label: "Additional synthetic checks", items: workingItems }
            : { key: "browser-discovery", label: nextStepOptionLabel("browser-discovery"), detail: "No checks created." };
      }
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
      // SelectMenu's own input handling (picking an option either
      // navigates away via setCurrentStep, or runs inline via
      // runExportNow). Whether there's actually anything left to offer is
      // handled reactively, below.
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
    if (currentStep === "next-steps" && nextStepsSubPhase === "menu" && availableNextStepOptions(nextStepsLog).length === 0) {
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
                <Text color={muted}>
                  {"     "}Skipping AI-powered suggestions — you'll be asked for a Synthetic Monitoring access token
                  later ({auth.error})
                </Text>
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
            {entry.items && entry.items.length > 0 && <Box flexDirection="column">{ItemsList(entry.items)}</Box>}
          </Box>
        ))}
        {analyzeMode !== "fast" && currentStep !== "next-steps" && (
          <Box flexDirection="column">
            <Text>
              {" "}
              {liveIcon()} <Text bold>{nextStepOptionLabel(analyzeMode)}</Text>
              {currentStep === "analyze" &&
                (analyzeSubPhase === "analyzing" || analyzeSubPhase === "discovering") && (
                  <Text color={muted}> — {analyzeProgress}%</Text>
                )}
            </Text>
            {items.length > 0 && <Box flexDirection="column">{ItemsList(items)}</Box>}
          </Box>
        )}
        {currentStep === "next-steps" && nextStepsSubPhase === "exporting" && (
          <Text>
            {" "}
            {liveIcon()} <Text bold>{nextStepOptionLabel("export")}</Text>
          </Text>
        )}
      </Box>
    );
  }

  function Footer() {
    if (currentStep !== "create" || createSubPhase !== "reviewing" || (candidates?.length ?? 0) === 0) return null;
    // Same blank-line-before-the-hint spacing as the next-steps menu's own
    // hint (see NextStepsBody) — one line, same "· "-separated shape,
    // rather than three stacked lines (a selected-count line plus two more
    // hint lines) for what's all just keybind info.
    return (
      <Box marginTop={1}>
        <Text color={muted}>
          press{" "}
          <Text color={accent} bold>
            ⏎ enter
          </Text>{" "}
          to continue · space toggle · ↑↓ move
        </Text>
      </Box>
    );
  }

  function AnalyzeBody() {
    // The "can take up to a minute" expectation (ANALYZE_PROGRESS_TARGET_MS)
    // is set once, here, before the browser ever opens — "discovering"
    // doesn't repeat it: the dynamic StepsList row above already names the
    // action and shows its own live percentage, so a second spinner here
    // would just be noise on top of that.
    if (analyzeSubPhase === "browser-confirm")
      return (
        <Box flexDirection="column">
          <Text>
            Open a real browser to look for additional synthetic checks on{" "}
            <Text color={url}>{initialTargetUrl}</Text>?
          </Text>
          <EnterHint suffix="or n to skip" />
        </Box>
      );
    return null;
  }

  // Every candidate an earlier pass already created/updated/skipped —
  // regardless of outcome, it's been through review once and shouldn't be
  // re-litigated or re-counted by a later pass. Shared by SelectBody (hide
  // it from the review list) and runCreate/checksCreatedLine (don't
  // double-count it into the summary).
  function handledCandidateKeys(): Set<string> {
    return new Set([...firstPassItems, ...extraCreatedItems].map((it) => it.candidate.key));
  }

  // The common case (a fresh setup) reads as "3 checks created." — the
  // more clinical "3 checks: 2 created, 1 already exists." only shows up
  // once results are actually mixed. Shared by the next-steps menu (shown
  // before every pass through it) and the final done screen (see
  // ChecksSummary) so the two never drift apart.
  function checksCreatedLine(): string {
    const allItems = [...firstPassItems, ...extraCreatedItems];
    if (allItems.length === 0) return "Nothing to do.";
    const createdCount = allItems.filter((it) => it.status === "created").length;
    if (createdCount === allItems.length) return `${allItems.length} check${allItems.length === 1 ? "" : "s"} created.`;
    const updatedCount = allItems.filter((it) => it.status === "updated").length;
    const skippedCount = allItems.filter((it) => it.status === "skipped").length;
    const parts = [
      createdCount > 0 ? `${createdCount} created` : "",
      updatedCount > 0 ? `${updatedCount} updated` : "",
      skippedCount > 0 ? `${skippedCount} already ${skippedCount === 1 ? "exists" : "exist"}` : "",
    ].filter(Boolean);
    return `${allItems.length} check${allItems.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  }

  // Shown before the next-steps menu on every visit, and again (without
  // the menu) on the final done screen — the check count and link, so the
  // user always knows what's already live before deciding what, if
  // anything, to do next.
  function ChecksSummary() {
    return (
      <Box flexDirection="column">
        <Text>{checksCreatedLine()}</Text>
        <Text color={muted}>
          View checks: <Text color={url}>{initialStackUrl.replace(/\/$/, "")}/a/grafana-synthetic-monitoring-app/checks</Text>
        </Text>
      </Box>
    );
  }

  function NextStepsBody() {
    // While exporting, its own live row is in StepsList instead (right
    // under the checklist — see the dynamic row there), the same spot its
    // permanent checkmark entry lands in once it's done. Nothing shows
    // here for that whole stretch, rather than a separate loading view
    // in an entirely different spot that then has to hand off to
    // StepsList once it finishes.
    if (nextStepsSubPhase === "exporting") return null;
    return (
      <Box flexDirection="column">
        <ChecksSummary />
        {nextStepsNotice && <Text color={muted}>{nextStepsNotice}</Text>}
        <Box marginTop={1} flexDirection="column">
          <Text bold>Next actions</Text>
          <SelectMenu items={availableNextStepOptions(nextStepsLog)} accentColor={accent ?? "white"} onSelect={handleNextStepChoice} />
        </Box>
        <Box marginTop={1}>
          <Text color={muted}>
            press{" "}
            <Text color={accent} bold>
              ⏎ enter
            </Text>{" "}
            to trigger an action · ↑↓ move · q to finish
          </Text>
        </Box>
      </Box>
    );
  }

  function SelectBody() {
    if (!candidates) return null;
    // Candidates a prior pass already handled drop out of what's shown
    // here, so a discovery pass reviews only what's new instead of
    // re-listing checks that already exist — runCreate's own `selected`
    // filters them out again regardless of what CheckboxList submits, so
    // hiding them here is purely about the review screen, not about
    // keeping them out of the actual create loop.
    const handled = handledCandidateKeys();
    const visible = candidates.filter((c) => !handled.has(c.key));
    return (
      <Box flexDirection="column">
        <Text>
          {analyzeMode === "fast"
            ? "These are the synthetic checks we suggest creating"
            : "These are the additional synthetic checks we suggest creating"}
        </Text>
        <CheckboxList
          items={visible.map((c) => ({
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
      </Box>
    );
  }

  // Shared between the live "creating" progress view and the final done
  // screen, which keeps showing the same list rather than swapping it out
  // for a plain summary once finished.
  function ItemsList(list: CreationItem[]) {
    // The dash is what visually connects the check to its locations —
    // dropping it (in favor of column alignment) left "Uptime" and
    // "London, Ohio" looking unrelated. No padding/alignment here on
    // purpose, so a long AI-discovered title (still length-capped — see
    // MAX_AI_TITLE_LENGTH in discover.ts) never has to fight a fixed
    // column width either.
    const loadZones = assignedProbes.join(", ");
    return list.map((it) => (
      <Text key={it.candidate.key}>
        {"     "}
        <ItemIcon status={it.status} /> {it.candidate.title}
        {loadZones && <Text color={muted}> — {loadZones}</Text>}
        {it.detail ? <Text color={muted}> · {it.detail}</Text> : null}
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
              Generate one here: <Text color={url}>{tokenPageUrl}</Text>
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
          Let's set up synthetic checks for <Text color={url}>{initialTargetUrl}</Text>
        </Text>
        <EnterHint />
      </Box>
    );
  }

  if (done) {
    // The completed checklist (StepsList, including every next-steps pick
    // that ran) stays visible above this — finishing (via 'q' or running
    // out of picks) never replaces it with a separate "we're done"
    // message, it just leaves the summary and link that were already
    // showing in place.
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        {StepsList()}
        <Box marginTop={1}>
          <ChecksSummary />
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
          (currentStep === "auth" && (auth.subPhase === "browser-confirm" || auth.subPhase === "authenticating")) ||
          (currentStep === "analyze" && analyzeSubPhase === "browser-confirm") ||
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
