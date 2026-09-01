import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { Wordmark } from "./brand";
import { Panel, SearchField, KeyBar, MenuRow, Fact } from "./chrome";
import {
  checkInventoryDomain,
  loadAttachSnapshot,
  type AttachSnapshot,
  type DomainCheck,
  type InventoryItem,
} from "../subcommands/menu/domain-bind";

type Focus = "search" | "list" | "detail";

function expiryDay(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function isExpired(iso?: string): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

function summary(item: InventoryItem): { text: string; tone?: "green" | "red" | "yellow" } {
  if (item.registration?.registered === false) return { text: "lapsed", tone: "red" };
  if (isExpired(item.expiresAt) || isExpired(item.registration?.expiresAt)) {
    return { text: `expired ${expiryDay(item.registration?.expiresAt || item.expiresAt)}`, tone: "red" };
  }
  const exp = expiryDay(item.expiresAt || item.registration?.expiresAt);
  if (exp) return { text: `exp ${exp}`, tone: "green" };
  if (item.status === "hosted") return { text: "hosted", tone: "yellow" };
  return { text: item.status === "owned" ? "owned" : "—" };
}

function boundTo(snapshot: AttachSnapshot, hostname: string): string {
  const hits = snapshot.apps.filter((row) =>
    row.domains.some((d) => d.hostname.toLowerCase() === hostname.toLowerCase())
  );
  if (hits.length === 0) return "none";
  return hits.map((row) => row.app.name).join(", ");
}

export function MyDomainsScreen({ onExit, crumb }: { onExit: () => void; crumb?: string }) {
  const { stdout } = useStdout();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AttachSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Focus>("search");
  const [selected, setSelected] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [checks, setChecks] = useState<Record<string, DomainCheck>>({});
  const [checking, setChecking] = useState(false);
  const inputArmed = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputArmed.current = true;
    }, 180);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    try {
      setSnapshot(loadAttachSnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const inventory = snapshot?.inventory ?? [];
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = q
      ? inventory.filter(
          (item) => item.domain.toLowerCase().includes(q) || item.provider.toLowerCase().includes(q)
        )
      : inventory;
    return [...rows].sort((a, b) => a.domain.localeCompare(b.domain));
  }, [inventory, q]);

  const listH = Math.max(8, (stdout?.rows ?? 24) - 18);
  const item = filtered[selected];

  useEffect(() => {
    setSelected(0);
    setWindowStart(0);
  }, [q]);

  useEffect(() => {
    if (selected < windowStart) setWindowStart(selected);
    else if (selected >= windowStart + listH) setWindowStart(selected - listH + 1);
  }, [selected, listH, windowStart]);

  const visible = filtered.slice(windowStart, windowStart + listH);
  const title = crumb || "My domains";

  const runCheck = (domain: string) => {
    if (checking) return;
    setChecking(true);
    try {
      const result = checkInventoryDomain(domain);
      setChecks((prev) => ({ ...prev, [domain]: result }));
    } finally {
      setChecking(false);
    }
  };

  useInput((input, key) => {
    if (!inputArmed.current) return;
    if (key.escape || key.leftArrow) {
      if (focus === "detail") {
        setFocus("list");
        return;
      }
      if (focus === "list") {
        setFocus("search");
        return;
      }
      onExit();
      return;
    }
    if (focus === "detail") {
      if (key.return) {
        setFocus("list");
        return;
      }
      if (input === "v" && item) runCheck(item.domain);
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === "search" ? "list" : "search"));
      return;
    }
    if (key.downArrow) {
      if (filtered.length === 0) return;
      setFocus("list");
      setSelected((i) => (i + 1) % filtered.length);
      return;
    }
    if (key.upArrow) {
      if (focus === "search") return;
      if (filtered.length === 0) return;
      setSelected((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (key.return && item) {
      setFocus("detail");
      return;
    }
    if (input === "v" && item && focus === "list") {
      runCheck(item.domain);
      return;
    }
    if (focus !== "search") {
      if (input && !key.ctrl && input !== "v") {
        setFocus("search");
        setQuery((q0) => q0 + input);
      }
      if (key.backspace || key.delete) {
        setFocus("search");
        setQuery((q0) => q0.slice(0, -1));
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q0) => q0.slice(0, -1));
      return;
    }
    if (input && !key.ctrl) setQuery((q0) => q0 + input);
  });

  if (focus === "detail" && item && snapshot) {
    const check = checks[item.domain];
    const marker = summary(item);
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Wordmark crumb={`${title} › ${item.domain}`} />
        <Panel marginTop={1} accent title="domain">
          <Fact label="name" value={item.domain} />
          <Fact label="provider" value={item.provider} />
          <Fact label="kind" value={item.status === "hosted" ? "hosted (panel)" : item.status || "owned"} />
          <Fact
            label="expiry"
            value={expiryDay(item.expiresAt) || expiryDay(item.registration?.expiresAt) || "not in inventory"}
            color={marker.tone}
          />
          <Fact label="app" value={boundTo(snapshot, item.domain)} dim={boundTo(snapshot, item.domain) === "none"} />
        </Panel>
        <Panel marginTop={1} title="live check">
          {checking ? (
            <Text dimColor>Checking DNS / registrar…</Text>
          ) : check ? (
            <>
              <Fact label="status" value={check.status || "—"} />
              <Fact label="via" value={check.provider || "—"} />
              {check.priceUsd != null ? <Fact label="price" value={`$${check.priceUsd.toFixed(2)}`} /> : null}
              <Fact label="note" value={check.detail || check.error || "—"} dim />
            </>
          ) : (
            <Text dimColor>v  live DNS/RDAP (and price if a registrar is connected)</Text>
          )}
        </Panel>
        <KeyBar hint="v check · esc/←/enter back" />
      </Box>
    );
  }

  const counts = new Map<string, number>();
  for (const row of inventory) counts.set(row.provider, (counts.get(row.provider) || 0) + 1);
  const countLine = [...counts.entries()].map(([id, n]) => `${id} ${n}`).join(" · ");

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={title} />
      {loading ? (
        <Panel marginTop={1}>
          <Text dimColor>Loading inventory…</Text>
        </Panel>
      ) : error ? (
        <Panel marginTop={1}>
          <Text color="red">{error}</Text>
        </Panel>
      ) : inventory.length === 0 ? (
        <Panel marginTop={1}>
          <Text>No domains in inventory.</Text>
          <Text dimColor>Connect a registrar under Domains › Connect registrar.</Text>
        </Panel>
      ) : (
        <>
          <Box marginTop={1}>
            <SearchField value={query} placeholder="filter by name or provider" focused={focus === "search"} />
          </Box>
          <Panel
            marginTop={1}
            title={`${filtered.length} of ${inventory.length}${
              filtered.length > listH ? ` · ${windowStart + 1}–${windowStart + visible.length}` : ""
            }${countLine ? ` · ${countLine}` : ""}`}
          >
            {visible.length === 0 ? (
              <Text dimColor>No matches</Text>
            ) : (
              visible.map((row, i) => {
                const index = windowStart + i;
                const active = focus === "list" && index === selected;
                const mark = summary(row);
                return (
                  <MenuRow
                    key={`${row.provider}:${row.domain}`}
                    index={index + 1}
                    label={row.domain}
                    suffix={`  ${row.provider}  ${mark.text}`}
                    active={active}
                    danger={mark.tone === "red"}
                  />
                );
              })
            )}
          </Panel>
          {item && snapshot && focus !== "search" ? (
            <Panel marginTop={1} accent title="inspect">
              <Fact label="name" value={item.domain} />
              <Fact label="kind" value={summary(item).text} color={summary(item).tone} />
              <Fact label="app" value={boundTo(snapshot, item.domain)} dim={boundTo(snapshot, item.domain) === "none"} />
            </Panel>
          ) : null}
        </>
      )}
      <KeyBar
        hint={
          inventory.length === 0
            ? "esc/← back"
            : "type to filter · ↑↓ select · ↵ details · v check · tab search/list · esc/← back"
        }
      />
    </Box>
  );
}
