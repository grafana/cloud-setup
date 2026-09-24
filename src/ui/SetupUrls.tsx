import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import { EditableTextInput } from "./EditableTextInput.js";
import { recordStep, type Command } from "../telemetry.js";
import { COLORS } from "../theme.js";
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
      <Header stackUrl={stackUrl || "Not set"} />
      <UrlInput
        key={field}
        kind={field}
        initialValue={(field === "target" ? initialTargetUrl : initialStackUrl) ?? ""}
        onSubmit={field === "target" ? setTargetUrl : setStackUrl}
      />
    </Box>
  );
}

function UrlInput({
  kind,
  initialValue,
  onSubmit,
}: {
  kind: UrlKind;
  initialValue: string;
  onSubmit: (url: string) => void;
}) {
  const [error, setError] = useState(() => (initialValue ? validateSetupUrl(initialValue, kind).error : undefined));
  const label = kind === "target" ? "Target URL" : "Grafana Cloud stack (slug or URL)";
  return (
    <Box flexDirection="column">
      <Text>
        {kind === "target"
          ? "What is the URL of the service you want to monitor?"
          : "Which Grafana Cloud stack should we use?"}
      </Text>
      <Text color={COLORS.MUTED}>
        {kind === "target"
          ? "You can enter a full URL (e.g. https://example.com) or just the domain (e.g. example.com)"
          : "You can enter a full URL (e.g. https://my-team.grafana.net) or just the slug (e.g. my-team)"}
      </Text>
      <Box>
        <Text>{label}: </Text>
        <EditableTextInput
          initialValue={initialValue}
          onSubmit={(raw) => {
            const result = validateSetupUrl(raw, kind);
            if (result.error !== undefined) setError(result.error);
            else onSubmit(result.url);
          }}
        />
      </Box>
      {error && <Text color={COLORS.BAD}>{error}</Text>}
      <Text color={COLORS.MUTED}>Ctrl+C to cancel</Text>
    </Box>
  );
}
