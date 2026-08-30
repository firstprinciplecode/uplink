import { Box, Text } from "ink";
import type { MenuStatus } from "./App";
import { formatBytes } from "./format";

const LABEL_WIDTH = 12;
const SPACE_GAUGE = 16;

function formatLimit(n: number): string {
  return n < 0 ? "∞" : String(n);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function SpaceMetric({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  const used = Math.max(0, usedBytes);
  const unlimited = limitBytes < 0;
  const cap = unlimited ? Math.max(used, 1) : Math.max(limitBytes, 1);
  const left = unlimited ? used : Math.max(0, limitBytes - used);
  const ratio = unlimited ? 0 : Math.min(1, used / cap);
  const filled = Math.round(ratio * SPACE_GAUGE);
  const nearlyFull = !unlimited && ratio >= 0.85;

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={LABEL_WIDTH}>
          <Text dimColor>space</Text>
        </Box>
        <Text>
          <Text color={nearlyFull ? "red" : "green"}>{"█".repeat(filled)}</Text>
          <Text dimColor>{"░".repeat(SPACE_GAUGE - filled)}</Text>
          <Text dimColor>
            {"  "}
            {unlimited ? `${formatBytes(used)} used` : `${formatBytes(left)} left`}
          </Text>
        </Text>
      </Box>
      <Box>
        <Box width={LABEL_WIDTH}>
          <Text> </Text>
        </Box>
        <Text dimColor>
          {unlimited ? "unlimited" : `of ${formatBytes(limitBytes)} hosting budget`}
        </Text>
      </Box>
    </Box>
  );
}

export function HomeStatus({ status }: { status: MenuStatus }) {
  const latency =
    status.connected && status.latencyMs != null ? `${status.latencyMs}ms` : "0ms";
  const plan = status.alwaysOn ? "always-on" : `sleep after ${status.idleMinutes ?? 30}m idle`;

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text color={status.connected ? "green" : "yellow"}>
          ● {status.connected ? "connected" : "offline"}
        </Text>
        <Text dimColor> · {latency}</Text>
      </Box>
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{"─".repeat(36)}</Text>
      </Box>
      <Box flexDirection="column">
        <Metric
          label="apps"
          value={`${status.apps.length} / ${formatLimit(status.appLimit)}`}
        />
        <Metric label="tunnels" value={String(status.tunnels.length)} />
        <Metric label="registrars" value={String(status.providers.length)} />
        <SpaceMetric usedBytes={status.storageUsedBytes} limitBytes={status.storageLimitBytes} />
        <Metric label="plan" value={plan} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(36)}</Text>
      </Box>
    </Box>
  );
}
