import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { COLORS, ICONS } from "../../theme.js";
import { Link } from "../shared.js";
import type { CreationItem } from "./model.js";
import { StepDetail } from "../workflow/StepDetail.js";

export function CheckResults({ items }: { items: CreationItem[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <StepDetail key={item.candidate.key}>
          <Text
            color={
              item.status === "failed"
                ? COLORS.BAD
                : item.status === "created" || item.status === "updated"
                  ? COLORS.OK
                  : COLORS.MUTED
            }
          >
            {item.status === "running" ? (
              <Spinner type="dots" />
            ) : item.status === "created" || item.status === "updated" ? (
              ICONS.OK
            ) : item.status === "failed" ? (
              ICONS.FAIL
            ) : item.status === "skipped" || item.status === "not-run" ? (
              ICONS.SKIPPED
            ) : (
              ICONS.PENDING
            )}
          </Text>{" "}
          {item.candidate.title}
          <Text color={COLORS.MUTED}>
            {" "}
            - {item.probes.join(", ")}
            {item.status === "failed" ? " · failed" : item.detail ? ` · ${item.detail}` : ""}
          </Text>
        </StepDetail>
      ))}
    </Box>
  );
}

function checksCreatedLine(items: CreationItem[]) {
  if (!items.length) return "Nothing to do.";
  const count = (status: CreationItem["status"]) => items.filter((item) => item.status === status).length;
  const noun = `check${items.length === 1 ? "" : "s"}`;
  if (count("created") === items.length) return `${items.length} ${noun} created.`;
  const parts = [
    count("created") ? `${count("created")} created` : "",
    count("updated") ? `${count("updated")} updated` : "",
    count("skipped") ? `${count("skipped")} already exist` : "",
  ].filter(Boolean);
  return `${items.length} ${noun}: ${parts.join(", ")}.`;
}
export function ChecksSummary({ items, stackUrl }: { items: CreationItem[]; stackUrl: string }) {
  return (
    <Box flexDirection="column">
      <Text>{checksCreatedLine(items)}</Text>
      <Text color={COLORS.MUTED}>
        View checks: <Link>{stackUrl.replace(/\/$/, "")}/a/grafana-synthetic-monitoring-app/checks</Link>
      </Text>
    </Box>
  );
}
