import { Box, Text } from "ink";
import type { MenuStatus } from "./App";
import { Wordmark } from "./brand";

const LABEL_WIDTH = 12;
const BAR_CAP = 24;

function CountBar({ count }: { count: number }) {
  if (count <= 0) return null;
  const filled = Math.min(count, BAR_CAP);
  return (
    <Text>
      <Text color="green">{"█".repeat(filled)}</Text>
      {count > BAR_CAP ? <Text dimColor> +{count - BAR_CAP}</Text> : null}
    </Text>
  );
}

function Metric({ label, count }: { label: string; count: number }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box width={4}>
        {count > 0 ? <Text>{count}</Text> : <Text dimColor>—</Text>}
      </Box>
      <CountBar count={count} />
    </Box>
  );
}

export function HomeStatus({ status }: { status: MenuStatus }) {
  const latency =
    status.connected && status.latencyMs != null ? `${status.latencyMs}ms` : "—";

  return (
    <Box flexDirection="column">
      <Wordmark />
      <Box marginTop={1}>
        <Text color={status.connected ? "green" : "red"}>
          {status.connected ? "connected" : "offline"}
        </Text>
        <Text dimColor> · {latency}</Text>
      </Box>
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{"─".repeat(36)}</Text>
      </Box>
      <Box flexDirection="column">
        <Metric label="apps" count={status.apps.length} />
        <Metric label="tunnels" count={status.tunnels.length} />
        <Metric label="registrars" count={status.providers.length} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(36)}</Text>
      </Box>
    </Box>
  );
}
