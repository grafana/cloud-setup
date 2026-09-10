import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { SmApiError, SmClient, type Probe } from "../api.js";
import { plan as buildPlan } from "../reconcile.js";
import { writeCredentials } from "../credentials.js";
import { candidatesFor, type Candidate } from "../discover.js";
import { detectFramework } from "../framework.js";
import { isGcxInstalled, installGcx, GCX_INSTALL_COMMAND, loginGcx } from "../gcx.js";
import { getSkillStatus, installSkill } from "../skills.js";
import { CheckboxList } from "./CheckboxList.js";
import type { SyntheticConfig } from "../types.js";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 6;

// Every automatic spinner/loading-bar phase stays visible at least this
// long, even when the real work behind it finishes faster.
const MIN_SPINNER_MS = 3000;
const ANALYZE_MIN_MS = 5000;

const FOLLOWUP_OPTIONS = ["export them as Terraform", "instrument your app with Frontend O11y"];

const NO_COLOR = Boolean(process.env.NO_COLOR);
const accent = NO_COLOR ? undefined : "#FFA500";
const ok = NO_COLOR ? undefined : "green";
const bad = NO_COLOR ? undefined : "red";
const muted = NO_COLOR ? undefined : "gray";
const ANIMATE = Boolean(process.stdout.isTTY) && !NO_COLOR;

function formatFolder(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

// Computed once — the working directory doesn't change during a run.
const PROJECT_FOLDER = formatFolder(process.cwd());
const PROJECT_TYPE = detectFramework(process.cwd());

// Read from package.json rather than hardcoded, so the two can't drift.
function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PACKAGE_VERSION = readPackageVersion();

function checkNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    throw new Error(`Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (found ${process.versions.node}).`);
  }
}

// Any HTTP response at all (even 401/404) proves the host is real and
// speaking HTTP; only a network-level failure means the URL is bad. Not
// authenticated — just enough to make "Connecting…" a real check.
async function probeReachable(url: string): Promise<void> {
  await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((err) => {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

const ACRONYMS = new Set(["ssl"]);

function titleCase(s: string): string {
  if (ACRONYMS.has(s.toLowerCase())) return s.toUpperCase();
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatFrequency(ms: number): string {
  const seconds = ms / 1000;
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

function Working({ label }: { label: string }) {
  return (
    <Text>
      {ANIMATE ? (
        <Text color={accent}>
          <Spinner type="dots" />
        </Text>
      ) : (
        "…"
      )}{" "}
      {label}
    </Text>
  );
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
}

// The five macro-steps shown in the persistent step list. "select"/"create"
// are editable (can be a `b` back-navigation target); "gcx", "skills", and
// "analyze" are fully automatic — once done, they stay done even if you
// navigate back past them, since there's nothing to reconfirm.
type StepId = "gcx" | "skills" | "analyze" | "select" | "create";

const STEP_ORDER: StepId[] = ["gcx", "skills", "analyze", "select", "create"];
const EDITABLE_STEPS: StepId[] = ["select", "create"];
const STEP_LABELS: Record<StepId, string> = {
  gcx: "Configure Grafana Cloud CLI (gcx)",
  skills: "Configure skills",
  analyze: "Analyze project",
  select: "Review proposals",
  create: "Create Synthetic Checks",
};

function previousEditableStep(from: StepId): StepId | undefined {
  const idx = STEP_ORDER.indexOf(from);
  for (let i = idx - 1; i >= 0; i--) {
    if (EDITABLE_STEPS.includes(STEP_ORDER[i])) return STEP_ORDER[i];
  }
  return undefined;
}

// "gcx": just installing/authenticating the CLI itself.
type GcxSubPhase = "checking-gcx" | "gcx-install-confirm" | "gcx-installing" | "gcx-auth-confirm" | "gcx-auth";
const GCX_WAITING_SUBPHASES: GcxSubPhase[] = ["gcx-install-confirm", "gcx-auth-confirm"];

// "create": connecting to the SM API and authenticating with a token lives
// here (not in "gcx") since it's unrelated to the gcx CLI — it only needs to
// happen once, so a revisit via back-navigation skips straight to "creating"
// once `session` is populated.
type CreateSubPhase = "base-url-input" | "connecting" | "token-input" | "validating" | "creating";

interface Session {
  url: string;
  token: string;
  client: SmClient;
  probes: Probe[];
}

interface Props {
  initialBaseUrl?: string;
  initialTargetUrl: string;
  initialStackUrl: string;
  forceGcxInstall: boolean;
  forceGcxAuth: boolean;
}

export function SetupApp({ initialBaseUrl, initialTargetUrl, initialStackUrl, forceGcxInstall, forceGcxAuth }: Props) {
  const { exit } = useApp();

  const [started, setStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("gcx");
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [done, setDone] = useState(false);
  const [failureSummary, setFailureSummary] = useState<string>();

  // gcx step
  const [gcxSubPhase, setGcxSubPhase] = useState<GcxSubPhase>("checking-gcx");
  const [gcxReinstalling, setGcxReinstalling] = useState(false);


  // analyze step
  const [candidates, setCandidates] = useState<Candidate[]>();

  // select step — seeded once (in runAnalyze), then kept live via
  // CheckboxList's onSelectionChange so a back-then-forward round trip
  // restores the user's actual choices instead of resetting to defaults.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // create step
  const [createSubPhase, setCreateSubPhase] = useState<CreateSubPhase>("base-url-input");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [connectError, setConnectError] = useState<string>();
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string>();
  const [tokenPageUrl, setTokenPageUrl] = useState<string>();
  const [assignedProbes, setAssignedProbes] = useState<string[]>([]);
  const [items, setItems] = useState<CreationItem[]>([]);

  const session = useRef<Session>(undefined as unknown as Session);
  const baseUrlResolver = useRef<((url: string) => void) | undefined>(undefined);
  const tokenResolver = useRef<((token: string) => void) | undefined>(undefined);
  const selectResolver = useRef<((keys: string[]) => void) | undefined>(undefined);
  const gcxInstallResolver = useRef<((install: boolean) => void) | undefined>(undefined);
  const gcxAuthConfirmResolver = useRef<((proceed: boolean) => void) | undefined>(undefined);

  const backTarget = previousEditableStep(currentStep);
  const isWaiting =
    (currentStep === "gcx" && GCX_WAITING_SUBPHASES.includes(gcxSubPhase)) ||
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
      else if (input.toLowerCase() === "n") exit();
    },
    { isActive: !started }
  );

  // Quit is disabled while free text is being typed (a token or URL could
  // legitimately contain the letter q) — Ctrl+C still works there.
  const quittingBlocked = currentStep === "create" && (createSubPhase === "base-url-input" || createSubPhase === "token-input");
  useInput(
    (input) => {
      if (input.toLowerCase() === "q") exit();
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
      if (currentStep === "gcx" && gcxSubPhase === "gcx-install-confirm") {
        if (key.return || input.toLowerCase() === "y") gcxInstallResolver.current?.(true);
        else if (input.toLowerCase() === "n") gcxInstallResolver.current?.(false);
      }
      if (currentStep === "gcx" && gcxSubPhase === "gcx-auth-confirm") {
        if (key.return || input.toLowerCase() === "y") gcxAuthConfirmResolver.current?.(true);
        else if (input.toLowerCase() === "n") gcxAuthConfirmResolver.current?.(false);
      }
    },
    {
      isActive: currentStep === "gcx" && (gcxSubPhase === "gcx-install-confirm" || gcxSubPhase === "gcx-auth-confirm"),
    }
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
      checkNodeVersion();
      setGcxSubPhase("checking-gcx");
      let gcxAvailable = isGcxInstalled();
      await sleep(MIN_SPINNER_MS);
      if (cancelled) return;

      // The flag only surfaces this path when gcx is already there (so you
      // get offered a reinstall instead of nothing happening) — it never
      // skips the confirmation itself.
      if (forceGcxInstall || !gcxAvailable) {
        setGcxReinstalling(gcxAvailable);
        setGcxSubPhase("gcx-install-confirm");
        const shouldInstall = await new Promise<boolean>((resolve) => {
          gcxInstallResolver.current = resolve;
        });
        if (cancelled) return;
        if (shouldInstall) {
          setGcxSubPhase("gcx-installing");
          try {
            await Promise.all([installGcx(), sleep(MIN_SPINNER_MS)]);
            gcxAvailable = isGcxInstalled();
          } catch {
            gcxAvailable = false;
          }
        }
      }
      if (!gcxAvailable) {
        throw new Error("The Grafana Cloud CLI (gcx) is required. Install it, then run `synthetics` again.");
      }

      if (forceGcxAuth) {
        setGcxSubPhase("gcx-auth-confirm");
        const proceed = await new Promise<boolean>((resolve) => {
          gcxAuthConfirmResolver.current = resolve;
        });
        if (cancelled) return;
        if (proceed) {
          setGcxSubPhase("gcx-auth");
          // Sequential, not raced — login itself usually already takes
          // longer than MIN_SPINNER_MS (it's a human completing OAuth in a
          // browser), so racing it would show no pause at all once it's
          // done. This guarantees a real pause right after it finishes.
          await loginGcx();
          await sleep(MIN_SPINNER_MS);
        }
      }
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
          sleep(MIN_SPINNER_MS),
        ]);
      } catch {
        // Non-fatal — this is a nice-to-have for agent tooling, not core to creating checks.
      }
      if (cancelled) return;
      advance();
    }

    async function runAnalyze() {
      const targetUrl = /^https?:\/\//.test(initialTargetUrl) ? initialTargetUrl : `https://${initialTargetUrl}`;
      const [list] = await Promise.all([candidatesFor(targetUrl), sleep(ANALYZE_MIN_MS)]);
      if (cancelled) return;
      setCandidates(list);
      setSelectedKeys(list.filter((c) => c.selectedByDefault).map((c) => c.key));
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
          const candidateClient = new SmClient(url, token);
          try {
            probes = await candidateClient.listProbes();
            client = candidateClient;
            await writeCredentials({ baseUrl: url, token, stackUrl: initialStackUrl, email: undefined });
            session.current = { url, token, client, probes };
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
          updateItem(candidate.key, { status: "skipped", detail: "already up to date" });
          continue;
        }
        try {
          await Promise.all([
            action.kind === "create" ? session.current.client.createCheck(action.payload) : session.current.client.updateCheck(action.payload),
            sleep(MIN_SPINNER_MS),
          ]);
          const status: ItemStatus = action.kind === "create" ? "created" : "updated";
          updateItem(candidate.key, { status });
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
            `Could not create ${failed.candidate.label}: ${failed.detail}`
        );
      }
      advance();
      setDone(true);
    }

    async function run() {
      try {
        if (currentStep === "gcx") await runGcx();
        else if (currentStep === "skills") await runSkills();
        else if (currentStep === "analyze") await runAnalyze();
        else if (currentStep === "select") await runSelect();
        else if (currentStep === "create") await runCreate();
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
            row = (
              <Text>
                {" "}
                <Text color={ok}>✓</Text> <Text color={muted}>{STEP_LABELS[step]}</Text>
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
            row = (
              <Text>
                {" "}
                {icon} <Text color={muted}>{STEP_LABELS[step]}</Text>
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
            </Box>
          );
        })}
      </Box>
    );
  }

  function Footer({ primary }: { primary?: string }) {
    if (!primary) return null;
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={muted}>{primary}</Text>
      </Box>
    );
  }

  // Pure spinner sub-phases render nothing here — the step list's own
  // spinner next to "Install and configure the Grafana Cloud CLI" already
  // says something's happening; only the confirm prompts need extra text.
  function GcxBody() {
    if (gcxSubPhase === "gcx-install-confirm")
      return (
        <Box flexDirection="column">
          <Text>{gcxReinstalling ? "Reinstall the Grafana Cloud CLI (gcx)?" : "gcx isn't installed. Install it now?"}</Text>
          <Text color={muted}>{GCX_INSTALL_COMMAND}</Text>
          <Text color={muted}>(y/n)</Text>
        </Box>
      );
    if (gcxSubPhase === "gcx-auth-confirm")
      return (
        <Box flexDirection="column">
          <Text>Run gcx login now? This will open a browser.</Text>
          <Text color={muted}>(y/n)</Text>
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
            label: titleCase(c.label),
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
        {"   "}
        <ItemIcon status={it.status} /> {titleCase(it.candidate.label)}
        {loadZones && <Text color={muted}> — {loadZones}</Text>}
        {it.detail ? <Text color={muted}> — {it.detail}</Text> : null}
      </Text>
    ));
  }

  function CreateBody() {
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

  function footerPrimary(): string | undefined {
    if (currentStep === "select") return "space toggle   ↑↓ move   ↵ continue";
    return undefined;
  }

  if (!started) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Header stackUrl={initialStackUrl} />
        <Text>
          Let's set up your first Synthetic Monitoring checks for <Text bold>&lt;{initialTargetUrl}&gt;</Text> using
          this folder as context.
        </Text>
        <Text color={muted}>
          We'll also configure everything you need to continue iterating on them later on, e.g. Agent Skills.
        </Text>
        <Box marginTop={1}>
          <Text color={muted}>
            press{" "}
            <Text color={accent} bold>
              ⏎ enter
            </Text>{" "}
            to continue
          </Text>
        </Box>
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

        <Box marginTop={1}>
          <Text color={muted}>Looking for more? You could {FOLLOWUP_OPTIONS.join(" or ")} —  coming soon :)</Text>
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
          (currentStep === "create" && createSubPhase !== "connecting") ||
          (currentStep === "gcx" && (gcxSubPhase === "gcx-install-confirm" || gcxSubPhase === "gcx-auth-confirm"))
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
            {currentStep === "gcx" && GcxBody()}
            {currentStep === "select" && SelectBody()}
            {currentStep === "create" && CreateBody()}
          </>
        )}
      </Box>
      {!failureSummary && Footer({ primary: footerPrimary() })}
      {failureSummary && (
        <Box marginTop={1}>
          <Text color={muted}>Resolve the issue, then run `synthetics` again.</Text>
        </Box>
      )}
    </Box>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text color={muted}>{label.padEnd(14)}</Text>
      {value}
    </Text>
  );
}

function Header({ stackUrl }: { stackUrl: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold>🦕 @grafana/setup-cli</Text>
        <Text color={muted}> {PACKAGE_VERSION}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="Folder" value={PROJECT_FOLDER} />
        <Field label="Detected" value={PROJECT_TYPE} />
        <Field label="Stack" value={stackUrl} />
      </Box>
    </Box>
  );
}

export async function runSetupUI(
  initialBaseUrl: string | undefined,
  initialTargetUrl: string,
  initialStackUrl: string,
  forceGcxInstall: boolean,
  forceGcxAuth: boolean
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("synthetics requires an interactive terminal.");
  }
  const app = render(
    <SetupApp
      initialBaseUrl={initialBaseUrl}
      initialTargetUrl={initialTargetUrl}
      initialStackUrl={initialStackUrl}
      forceGcxInstall={forceGcxInstall}
      forceGcxAuth={forceGcxAuth}
    />
  );
  await app.waitUntilExit();
}
