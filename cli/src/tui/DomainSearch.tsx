import { Box, Text, useApp, useInput, render } from "ink";
import { Wordmark } from "./brand";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import type { PublicAvailability } from "../utils/domain-availability";
import { expandDomainQuery } from "../utils/domain-search";
import { checkDomainAvailability } from "../utils/domain-availability";
import { prepareStdinForPrompt } from "../subcommands/menu/io";

type Row = PublicAvailability | { domain: string; status: "checking" };

const DEBOUNCE_MS = 400;

function useLiveChecks(raw: string): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const domains = expandDomainQuery(raw);
    if (domains.length === 0) {
      setRows([]);
      return;
    }
    setRows(domains.map((domain) => ({ domain, status: "checking" as const })));
    const timer = setTimeout(() => {
      for (const domain of domains) {
        void checkDomainAvailability(domain).then((result) => {
          if (generation.current !== gen) return;
          setRows((prev) => prev.map((row) => (row.domain === domain ? result : row)));
        });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [raw]);

  return rows;
}

function statusColor(status: Row["status"]): string | undefined {
  if (status === "available") return "green";
  if (status === "taken") return undefined;
  if (status === "unknown") return "yellow";
  return undefined;
}

function DomainSearchApp() {
  const { exit } = useApp();
  const [query, setQuery] = useState("");
  const [showTaken, setShowTaken] = useState(false);
  const rows = useLiveChecks(query);
  const pending = rows.some((row) => row.status === "checking");
  const available = rows.filter((row) => row.status === "available");
  const taken = rows.filter((row) => row.status === "taken");
  const rest = rows.filter((row) => row.status !== "taken");

  useInput((_input, key) => {
    if (key.escape) exit();
    if (key.tab) setShowTaken((prev) => !prev);
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark />
      <Box marginTop={1}>
        <Text>Find a domain</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>search › </Text>
        <TextInput value={query} onChange={setQuery} placeholder="acme   or   acme.io" />
      </Box>
      {rest.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rest.map((row) => (
            <Text key={row.domain} color={statusColor(row.status)} dimColor={row.status === "checking"}>
              {row.status === "checking" ? "·" : row.status === "available" ? "✓" : "?"} {row.domain}
            </Text>
          ))}
        </Box>
      )}
      {taken.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {showTaken ? (
            taken.map((row) => (
              <Text key={row.domain} dimColor>
                × {row.domain}
              </Text>
            ))
          ) : (
            <Text dimColor>
              {taken.length} taken · tab to show
            </Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {rows.length > 0 && !pending ? `${available.length} of ${rows.length} free · ` : ""}
          tab taken · esc back · DNS + RDAP, no registrar required
        </Text>
      </Box>
    </Box>
  );
}

export async function runDomainSearch(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "Domain search needs a terminal. Agents: uplink domains search myapp --json";
  }
  const instance = render(<DomainSearchApp />);
  await instance.waitUntilExit();
  instance.unmount();
  prepareStdinForPrompt();
  return "";
}
