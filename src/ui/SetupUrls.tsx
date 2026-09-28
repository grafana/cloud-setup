import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box } from "ink";
import { UrlInput } from "./UrlInput.js";
import { recordStep, type Command } from "../telemetry.js";
import { validateSetupUrl, type UrlKind } from "../urls.js";
import { Header, useHardExit, type HardExit } from "./shared.js";

interface ResolvedUrls {
  targetUrl: string;
  stackUrl: string;
  exit: HardExit;
}

interface Props {
  command: Command;
  initialTargetUrl?: string;
  initialStackUrl?: string;
  children: (urls: ResolvedUrls) => ReactNode;
}

// Keep the product wizard unmounted until its required URLs are valid. This
// prevents input keys from also reaching its intro shortcuts, and prevents
// installers, authentication, or product operations from starting early.
export function SetupUrls({ command, initialTargetUrl, initialStackUrl, children }: Props) {
  const [targetUrl, setTargetUrl] = useState(() => validateSetupUrl(initialTargetUrl ?? "", "target").url ?? "");
  const [stackUrl, setStackUrl] = useState(() => validateSetupUrl(initialStackUrl ?? "", "stack").url ?? "");
  const exit = useHardExit(command, stackUrl);
  const field: UrlKind | undefined =
    command === "synthetics" && !targetUrl ? "target" : !stackUrl ? "stack" : undefined;
  const reported = useRef(false);

  useEffect(() => {
    if (field || reported.current) return;
    reported.current = true;
    recordStep(command, stackUrl, "urls", { status: "ok" });
  }, [command, field, stackUrl]);

  if (!field) return children({ targetUrl, stackUrl, exit });

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Header stackUrl={stackUrl || "-"} />
      <UrlInput
        key={field}
        kind={field}
        initialValue={(field === "target" ? initialTargetUrl : initialStackUrl) ?? ""}
        onSubmit={field === "target" ? setTargetUrl : setStackUrl}
      />
    </Box>
  );
}
