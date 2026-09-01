import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Wordmark } from "./brand";
import { Panel, KeyBar, MenuRow } from "./chrome";
import {
  bindCommands,
  loadAttachSnapshot,
  sampleHostname,
  type AttachAppInfo,
  type AttachSnapshot,
} from "../subcommands/menu/domain-bind";

function boundLabel(row: AttachAppInfo): string {
  if (row.domains.length === 0) return "no custom hostnames";
  return row.domains
    .slice(0, 2)
    .map((d) => `${d.hostname}${d.verified ? "" : " (pending)"}`)
    .join(", ") + (row.domains.length > 2 ? ` +${row.domains.length - 2}` : "");
}

function InspectPanel({
  row,
  sampleHost,
  inventoryCount,
}: {
  row: AttachAppInfo;
  sampleHost: string;
  inventoryCount: number;
}) {
  const cmds = bindCommands(row.app.id, sampleHost);
  return (
    <Panel marginTop={1} accent>
      <Text dimColor>attach</Text>
      <Text>
        <Text dimColor>url      </Text>
        {row.app.url || "—"}
      </Text>
      <Text>
        <Text dimColor>id       </Text>
        {row.app.id}
      </Text>
      <Text>
        <Text dimColor>bound    </Text>
        {boundLabel(row)}
      </Text>
      <Text dimColor>
        {inventoryCount === 0
          ? "no registrar inventory — pass any hostname you control"
          : `${inventoryCount} name${inventoryCount === 1 ? "" : "s"} in inventory`}
      </Text>
      <Text dimColor wrap="truncate">
        {cmds.add}
      </Text>
    </Panel>
  );
}

function DetailView({
  row,
  snapshot,
  crumb,
  onBack,
}: {
  row: AttachAppInfo;
  snapshot: AttachSnapshot;
  crumb: string;
  onBack: () => void;
}) {
  const sampleHost = sampleHostname(snapshot.inventory);
  const cmds = bindCommands(row.app.id, sampleHost);

  useInput((_input, key) => {
    if (key.escape || key.leftArrow || key.return) onBack();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={crumb} />
      <Panel marginTop={1} accent>
        <Text bold>{row.app.name}</Text>
        <Text dimColor>{row.app.url || row.app.id}</Text>
        <Text>Bound: {boundLabel(row)}</Text>
      </Panel>
      <Panel marginTop={1}>
        <Text dimColor>bind is one API call · DNS stays at the registrar</Text>
        <Text>{cmds.add}</Text>
        <Text>{cmds.verify}</Text>
        <Text dimColor>Free plans cannot attach custom domains (HOST_DOMAIN_NOT_ENABLED).</Text>
      </Panel>
      <Panel marginTop={1}>
        <Text dimColor>names you hold</Text>
        {snapshot.inventory.length === 0 ? (
          <Text dimColor>None listed. Connect a registrar, or tell the agent the hostname.</Text>
        ) : (
          snapshot.inventory.slice(0, 8).map((item) => (
            <Text key={item.domain}>
              {"  "}
              {item.domain}
              <Text dimColor>
                {"  "}
                {item.provider}
                {item.status === "hosted" ? " · hosted" : ""}
              </Text>
            </Text>
          ))
        )}
        {snapshot.inventory.length > 8 ? (
          <Text dimColor>  +{snapshot.inventory.length - 8} more</Text>
        ) : null}
      </Panel>
      <KeyBar hint="esc/←/enter back" />
    </Box>
  );
}

export function AttachAppScreen({
  onExit,
  crumb,
}: {
  onExit: () => void;
  crumb?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AttachSnapshot | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);

  useEffect(() => {
    try {
      setSnapshot(loadAttachSnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const rows = snapshot?.apps ?? [];
  const row = rows[selected];
  const title = crumb || "Attach to app";

  useInput(
    (_input, key) => {
      if (key.escape || key.leftArrow) {
        onExit();
        return;
      }
      if (rows.length === 0) return;
      if (key.upArrow) {
        setSelected((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      if (key.downArrow) {
        setSelected((i) => (i + 1) % rows.length);
        return;
      }
      if (key.return && row) setDetail(true);
    },
    { isActive: !detail }
  );

  if (detail && row && snapshot) {
    return (
      <DetailView
        row={row}
        snapshot={snapshot}
        crumb={`${title} › ${row.app.name}`}
        onBack={() => setDetail(false)}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={title} />
      {loading ? (
        <Panel marginTop={1}>
          <Text dimColor>Loading hosted apps…</Text>
        </Panel>
      ) : error ? (
        <Panel marginTop={1}>
          <Text color="red">{error}</Text>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel marginTop={1}>
          <Text>No hosted apps yet.</Text>
          <Text dimColor>Deploy one under Hosting, then bind a hostname from here.</Text>
        </Panel>
      ) : (
        <>
          <Panel marginTop={1}>
            <Text dimColor>apps</Text>
            {rows.map((item, i) => (
              <MenuRow
                key={item.app.id}
                index={i + 1}
                label={item.app.name}
                suffix={item.domains.length > 0 ? `  ${item.domains.length}` : ""}
                active={i === selected}
              />
            ))}
          </Panel>
          {row ? (
            <InspectPanel
              row={row}
              sampleHost={sampleHostname(snapshot?.inventory ?? [])}
              inventoryCount={snapshot?.inventory.length ?? 0}
            />
          ) : null}
        </>
      )}
      <KeyBar
        hint={
          rows.length > 0
            ? "↑↓ inspect · ↵ details · esc/← back"
            : "esc/← back"
        }
      />
    </Box>
  );
}
