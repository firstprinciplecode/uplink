import { Box, Text } from "ink";
import { Panel } from "./chrome";
import { useEffect, useState } from "react";
import type { MenuInspect } from "../subcommands/menu/types";
import { ARTIFACT_CAP_BYTES, fetchAppInspect, type AppInspect } from "./snapshot";
import { formatBytes, formatDate } from "./format";

const LABEL_WIDTH = 10;
const GAUGE_WIDTH = 16;

function Row({
  label,
  value,
  color,
  dim,
}: {
  label: string;
  value: string;
  color?: "green" | "red";
  dim?: boolean;
}) {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={color} dimColor={dim}>
        {value}
      </Text>
    </Box>
  );
}

function SizeGauge({ bytes }: { bytes: number }) {
  const ratio = Math.min(1, bytes / ARTIFACT_CAP_BYTES);
  const filled = Math.round(ratio * GAUGE_WIDTH);
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>size</Text>
      </Box>
      <Text>
        <Text color="white">{"█".repeat(filled)}</Text>
        <Text dimColor>{"░".repeat(GAUGE_WIDTH - filled)}</Text>
        <Text dimColor>
          {"  "}
          {formatBytes(bytes)} / {formatBytes(ARTIFACT_CAP_BYTES)}
        </Text>
      </Text>
    </Box>
  );
}

function statusColor(value?: string): "green" | "red" | undefined {
  if (!value) return undefined;
  if (value === "running" || value === "ready") return "green";
  if (value === "failed") return "red";
  return undefined;
}

export function AppInspector({ inspect }: { inspect?: MenuInspect }) {
  const [detail, setDetail] = useState<AppInspect | null>(null);
  const [loading, setLoading] = useState(false);

  // Narrow the union once: only the "app" variant carries an id.
  const appId = inspect?.kind === "app" ? inspect.id : undefined;

  useEffect(() => {
    if (!appId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      fetchAppInspect(appId).then((next) => {
        if (cancelled) return;
        setDetail(next);
        setLoading(false);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [appId]);

  if (!inspect || inspect.kind !== "app") return null;

  const url = detail?.url || inspect.url || "—";
  const deploy = detail?.deploy || (loading ? "…" : "—");
  const build = detail?.build || (loading ? "…" : "—");
  const domainText =
    detail && detail.domains.length > 0
      ? detail.domains
          .slice(0, 2)
          .map((domain) => `${domain.hostname}${domain.verified ? "" : " (pending)"}`)
          .join(", ") + (detail.domains.length > 2 ? ` +${detail.domains.length - 2}` : "")
      : loading && !detail
        ? "…"
        : "none";

  return (
    <Panel marginTop={1}>
      <Text dimColor>inspect</Text>
      <Row label="url" value={url} />
      <Row label="status" value={deploy} color={statusColor(detail?.deploy)} dim={!detail?.deploy} />
      <Row label="build" value={build} color={statusColor(detail?.build)} dim={!detail?.build} />
      {detail?.sizeBytes != null ? (
        <SizeGauge bytes={detail.sizeBytes} />
      ) : (
        <Row label="size" value={loading ? "…" : "none"} dim />
      )}
      <Row label="created" value={formatDate(detail?.createdAt || inspect.createdAt)} dim={!detail?.createdAt && !inspect.createdAt} />
      <Row label="domains" value={domainText} dim={domainText === "none"} />
    </Panel>
  );
}
