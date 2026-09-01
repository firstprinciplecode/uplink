import { Box, Text } from "ink";
import type { MenuStatus } from "./App";
import { formatBytes } from "./format";

const SPACE_GAUGE = 14;

function formatLimit(n: number): string {
  return n < 0 ? "∞" : String(n);
}

function Mini({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Box
      flexGrow={1}
      borderStyle="round"
      borderDimColor
      paddingX={1}
      flexDirection="column"
    >
      <Text dimColor>{label}</Text>
      <Text bold>{value}</Text>
    </Box>
  );
}

function SpacePanel({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  const used = Math.max(0, usedBytes);
  const unlimited = limitBytes < 0;
  const cap = unlimited ? Math.max(used, 1) : Math.max(limitBytes, 1);
  const left = unlimited ? used : Math.max(0, limitBytes - used);
  const ratio = unlimited ? 0 : Math.min(1, used / cap);
  const filled = Math.round(ratio * SPACE_GAUGE);

  return (
    <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
      <Text dimColor>space</Text>
      <Text>
        <Text color="white">{"█".repeat(filled)}</Text>
        <Text dimColor>{"░".repeat(SPACE_GAUGE - filled)}</Text>
        <Text dimColor>
          {"  "}
          {unlimited ? `${formatBytes(used)} used` : `${formatBytes(left)} left`}
        </Text>
      </Text>
      <Text dimColor>
        {unlimited ? "unlimited" : `of ${formatBytes(limitBytes)} hosting budget`}
      </Text>
    </Box>
  );
}

export function HomeStatus({ status }: { status: MenuStatus }) {
  const plan = status.alwaysOn ? "always-on" : `sleep ${status.idleMinutes ?? 30}m`;

  return (
    <Box flexDirection="column" marginTop={1} gap={0}>
      <Box gap={1}>
        <Mini label="apps" value={`${status.apps.length} / ${formatLimit(status.appLimit)}`} />
        <Mini label="tunnels" value={String(status.tunnels.length)} />
        <Mini label="registrars" value={String(status.providers.length)} />
        <Mini label="plan" value={plan} />
      </Box>
      <SpacePanel usedBytes={status.storageUsedBytes} limitBytes={status.storageLimitBytes} />
    </Box>
  );
}
