import { Box, Text, useApp, useInput, render } from "ink";
import { Wordmark } from "./brand";
import { Panel, SearchField, KeyBar } from "./chrome";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_TLDS,
  parseDomainFindQuery,
  expandDomainQuery,
  type SearchTldSet,
} from "../utils/domain-search";
import { checkDomainAvailability } from "../utils/domain-availability";
import { fetchRelatedWords } from "../utils/related-words";
import { BROWSE_STRATEGIES, loadDomainWords } from "../utils/domain-words";
import { prepareStdinForInk, enterTuiScreen, leaveTuiScreen } from "../subcommands/menu/io";
import { readRegistrarStore } from "../registrars/store";
import { getAdapter } from "../registrars";
import type { DomainQuote } from "../registrars/types";
import {
  createNamecheapAddFundsRequest,
  getNamecheapBalance,
  namecheapCartUrl,
  registerNamecheapDomain,
  fetchNamecheapDomainContact,
  type NamecheapBalance,
} from "../registrars/namecheap-purchase";
import {
  contactMissingFields,
  readRegistrantContact,
  writeRegistrantContact,
  type RegistrantContact,
} from "../utils/registrant-contact";
import { openInBrowser } from "../utils/open-browser";
import { useDomainScan, type ScanHit } from "./use-domain-scan";

type Row = {
  domain: string;
  status: "checking" | "available" | "taken" | "unknown";
  source?: "dns" | "rdap";
  detail?: string;
  priceUsd?: number;
  premium?: boolean;
  pricing?: boolean;
};
type Focus = "search" | "list" | "detail";

const DEBOUNCE_MS = 400;
const PRICE_SETTLE_MS = 900;
const SEARCH_PLACEHOLDER =
  "a name · a domain (creatures.inc) · browse a TLD (.inc) · related words (~space)";

function useLiveChecks(raw: string, tldSet: SearchTldSet): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const domains = expandDomainQuery(raw, tldSet);
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
  }, [raw, tldSet]);

  const priceKey = rows
    .filter((row) => row.status === "available" && row.priceUsd == null && !row.pricing)
    .map((row) => row.domain)
    .join(",");

  useEffect(() => {
    const creds = readRegistrarStore().namecheap;
    if (!creds || !priceKey) return;
    const domains = priceKey.split(",");
    const gen = generation.current;
    const timer = setTimeout(() => {
      setRows((prev) =>
        prev.map((row) => (domains.includes(row.domain) ? { ...row, pricing: true } : row))
      );
      for (const domain of domains) {
        void getAdapter("namecheap")
          .check(creds, domain)
          .then((quote) => {
            if (generation.current !== gen) return;
            setRows((prev) =>
              prev.map((row) => {
                if (row.domain !== domain) return row;
                if (quote.buyable === false) {
                  return {
                    ...row,
                    status: "unknown",
                    pricing: false,
                    detail: quote.error ?? "not for sale",
                  };
                }
                return {
                  ...row,
                  pricing: false,
                  priceUsd: quote.priceUsd,
                  premium: quote.premium,
                };
              })
            );
          })
          .catch(() => {
            if (generation.current !== gen) return;
            setRows((prev) =>
              prev.map((row) => (row.domain === domain ? { ...row, pricing: false } : row))
            );
          });
      }
    }, PRICE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [priceKey]);

  return rows;
}

function useRelatedWords(word: string | undefined) {
  const [words, setWords] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!word) {
      setWords([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setWords([]);
    setError(undefined);
    setLoading(true);
    const timer = setTimeout(() => {
      fetchRelatedWords(word)
        .then((result) => {
          if (cancelled) return;
          setWords(result);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : "failed to fetch related words");
          setLoading(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [word]);

  return { words, loading, error };
}

function statusGlyph(status: Row["status"]): string {
  if (status === "checking") return "·";
  if (status === "available") return "✓";
  if (status === "taken") return "×";
  return "?";
}

function statusColor(status: Row["status"]): string | undefined {
  if (status === "available") return "green";
  if (status === "unknown") return "yellow";
  return undefined;
}

function formatMoney(n: number | undefined, currency = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)} ${currency}`;
}

function priceSuffix(row: Row | ScanHit): string {
  if ("pricing" in row && row.pricing) return "  pricing…";
  if (row.priceUsd == null) return "";
  return `  $${row.priceUsd.toFixed(2)}/yr${row.premium ? " premium" : ""}`;
}

function hitToRow(hit: ScanHit): Row {
  return {
    domain: hit.domain,
    status: "available",
    source: "rdap",
    detail: "scan",
    priceUsd: hit.priceUsd,
    premium: hit.premium,
  };
}

async function ensureRegistrantContact(): Promise<RegistrantContact | null> {
  const existing = readRegistrantContact();
  if (existing && contactMissingFields(existing).length === 0) return existing;
  const store = readRegistrarStore();
  const creds = store.namecheap;
  if (!creds) return existing;
  try {
    const owned = await getAdapter("namecheap").listDomains(creds);
    for (const item of owned.slice(0, 5)) {
      const contact = await fetchNamecheapDomainContact(creds, item.domain);
      if (contact && contactMissingFields(contact).length === 0) {
        writeRegistrantContact(contact);
        return contact;
      }
    }
  } catch {
    /* ignore seed failures */
  }
  return existing;
}

type DetailState = {
  domain: string;
  publicStatus: Row["status"];
  loading: boolean;
  quote?: DomainQuote;
  balance?: NamecheapBalance;
  contact?: RegistrantContact | null;
  namecheapConnected: boolean;
  message?: string;
  error?: string;
};

function DomainDetail({
  state,
  actionHint,
}: {
  state: DetailState;
  actionHint: string;
}) {
  const quote = state.quote;
  const price = quote?.priceUsd;
  const balance = state.balance?.available;
  const shortfall =
    price != null && balance != null && balance + 0.001 < price ? price - balance : 0;
  const canBuy =
    state.namecheapConnected &&
    quote?.buyable &&
    quote.status === "available" &&
    shortfall <= 0 &&
    contactMissingFields(state.contact).length === 0;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={state.domain} />
      <Panel marginTop={1} accent>
        <Text bold>{state.domain}</Text>
        {state.loading ? (
          <Text dimColor>Looking up Namecheap price & balance…</Text>
        ) : (
          <>
            <Text>
              Public: {state.publicStatus}
              {quote ? ` · Namecheap: ${quote.status}` : ""}
              {quote?.premium ? " (premium)" : ""}
            </Text>
            <Text>
              Price: {formatMoney(price)}
              {state.balance ? ` · Balance: ${formatMoney(state.balance.available, state.balance.currency)}` : ""}
            </Text>
            {shortfall > 0 && (
              <Text color="yellow">Need ~{formatMoney(shortfall)} more in Namecheap balance to buy via API.</Text>
            )}
            {!state.namecheapConnected && (
              <Text dimColor>
                Connect Namecheap for price and buy: uplink domains providers connect namecheap
              </Text>
            )}
            {state.namecheapConnected && contactMissingFields(state.contact).length > 0 && (
              <Text color="yellow">
                Missing registrant profile ({contactMissingFields(state.contact).join(", ")}). Run: uplink
                domains contact set
              </Text>
            )}
            {state.error && <Text color="red">{state.error}</Text>}
            {state.message && <Text color="green">{state.message}</Text>}
          </>
        )}
      </Panel>
      <KeyBar
        hint={`${actionHint} · ${canBuy ? "b buy · " : ""}${state.namecheapConnected ? "f add funds · " : ""}o Namecheap cart · esc/← back`}
      />
    </Box>
  );
}

function ResultLine({ row, active }: { row: Row; active: boolean }) {
  return (
    <Text
      inverse={active}
      color={active ? undefined : statusColor(row.status)}
      dimColor={!active && (row.status === "checking" || row.status === "taken")}
    >
      {active ? " › " : "   "}
      {statusGlyph(row.status)} {row.domain}
      {row.status === "taken" ? "  taken" : ""}
      <Text dimColor={!active}>{priceSuffix(row)}</Text>
      {active ? "\u2800" : ""}
    </Text>
  );
}

export function DomainSearchApp({
  onExit,
  crumb,
}: {
  onExit?: () => void;
  crumb?: string;
} = {}) {
  const { exit } = useApp();
  const leave = onExit ?? exit;
  const [query, setQuery] = useState("");
  const [moreTlds, setMoreTlds] = useState(false);
  const [showTaken, setShowTaken] = useState(false);
  const [focus, setFocus] = useState<Focus>("search");
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitConfirm, setAwaitConfirm] = useState(false);
  const [strategyIndex, setStrategyIndex] = useState(0);
  const parsed = parseDomainFindQuery(query);
  const plainSearch = parsed.mode === "label" || parsed.mode === "exact";
  const liveRows = useLiveChecks(plainSearch ? query : "", moreTlds ? "more" : "default");
  const scan = useDomainScan();
  const related = useRelatedWords(parsed.mode === "related" ? parsed.word : undefined);
  const namecheapConnected = Boolean(readRegistrarStore().namecheap);

  useEffect(() => {
    scan.reset();
    setStrategyIndex(0);
    setFocus("search");
  }, [query, scan.reset]);

  const scanWasRunning = useRef(false);
  useEffect(() => {
    if (scanWasRunning.current && !scan.state.running && scan.state.found.length > 0) {
      setFocus("list");
      setSelected(0);
    }
    scanWasRunning.current = scan.state.running;
  }, [scan.state.running, scan.state.found.length]);

  const rows = useMemo(() => {
    if (parsed.mode === "browse" || parsed.mode === "related") {
      return scan.state.found.map(hitToRow);
    }
    return liveRows;
  }, [parsed.mode, scan.state.found, liveRows]);

  const available = rows.filter((row) => row.status === "available");
  const taken = rows.filter((row) => row.status === "taken");
  const rest = rows.filter((row) => row.status !== "taken");
  const visible = useMemo(() => {
    if (parsed.mode === "browse" || parsed.mode === "related") return rows;
    return showTaken ? [...rest, ...taken] : rest;
  }, [parsed.mode, rows, rest, taken, showTaken]);

  useEffect(() => {
    setSelected((i) => (visible.length === 0 ? 0 : Math.min(i, visible.length - 1)));
  }, [visible.length]);

  const openDetail = useCallback(async (row: Row) => {
    const store = readRegistrarStore();
    const creds = store.namecheap;
    setFocus("detail");
    setAwaitConfirm(false);
    setDetail({
      domain: row.domain,
      publicStatus: row.status,
      loading: Boolean(creds),
      namecheapConnected: Boolean(creds),
    });
    if (!creds) return;
    try {
      const [quote, balance, contact] = await Promise.all([
        getAdapter("namecheap").check(creds, row.domain),
        getNamecheapBalance(creds),
        ensureRegistrantContact(),
      ]);
      setDetail({
        domain: row.domain,
        publicStatus: row.status,
        loading: false,
        quote,
        balance,
        contact,
        namecheapConnected: true,
      });
    } catch (error) {
      setDetail({
        domain: row.domain,
        publicStatus: row.status,
        loading: false,
        namecheapConnected: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      setFocus("list");
      setSelected((i) => (i + delta + visible.length) % visible.length);
    },
    [visible.length]
  );

  const runBuy = useCallback(async () => {
    if (!detail || busy) return;
    const store = readRegistrarStore();
    const creds = store.namecheap;
    if (!creds || !detail.quote?.buyable || !detail.contact) return;
    setBusy(true);
    try {
      const result = await registerNamecheapDomain(creds, {
        domain: detail.domain,
        years: 1,
        contact: detail.contact,
        premium: detail.quote.premium,
        premiumPrice: detail.quote.premium ? detail.quote.priceUsd : undefined,
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              message: result.registered
                ? `Registered ${result.domain}${result.chargedAmount != null ? ` · charged $${result.chargedAmount.toFixed(2)}` : ""}`
                : `Create returned registered=false for ${result.domain}`,
              error: undefined,
            }
          : prev
      );
      setAwaitConfirm(false);
    } catch (error) {
      setDetail((prev) =>
        prev
          ? { ...prev, error: error instanceof Error ? error.message : String(error), message: undefined }
          : prev
      );
    } finally {
      setBusy(false);
    }
  }, [busy, detail]);

  const runFund = useCallback(async () => {
    if (!detail || busy) return;
    const store = readRegistrarStore();
    const creds = store.namecheap;
    if (!creds) return;
    const price = detail.quote?.priceUsd ?? 10;
    const balance = detail.balance?.available ?? 0;
    const need = Math.max(10, Math.ceil(Math.max(price - balance, price) + 1));
    setBusy(true);
    try {
      const funds = await createNamecheapAddFundsRequest(creds, need);
      openInBrowser(funds.redirectUrl);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              message: `Opened Namecheap payment page for $${funds.amount.toFixed(2)}. After funding, press b to buy.`,
              error: undefined,
            }
          : prev
      );
    } catch (error) {
      setDetail((prev) =>
        prev
          ? { ...prev, error: error instanceof Error ? error.message : String(error), message: undefined }
          : prev
      );
    } finally {
      setBusy(false);
    }
  }, [busy, detail]);

  const goBack = useCallback(() => {
    if (focus === "detail") {
      setDetail(null);
      setFocus(visible.length ? "list" : "search");
      setAwaitConfirm(false);
      return;
    }
    if (focus === "list") {
      setFocus("search");
      return;
    }
    leave();
  }, [leave, focus, visible.length]);

  const startOrStopScan = useCallback(() => {
    if (scan.state.running) {
      scan.stop();
      return;
    }
    if (parsed.mode === "browse") {
      const strategy = BROWSE_STRATEGIES[strategyIndex] ?? BROWSE_STRATEGIES[0];
      scan.start([parsed.tld], async () => strategy.generate(await loadDomainWords()));
      return;
    }
    if (parsed.mode === "related" && related.words.length > 0) {
      scan.start(parsed.tld ? [parsed.tld] : DEFAULT_TLDS, () => Promise.resolve(related.words));
    }
  }, [scan, parsed, strategyIndex, related.words]);

  const inputArmed = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      inputArmed.current = true;
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  useInput((input, key) => {
    if (!inputArmed.current) return;
    if (key.escape || key.leftArrow) {
      if (focus === "detail" && awaitConfirm) {
        setAwaitConfirm(false);
        return;
      }
      goBack();
      return;
    }
    if (busy) return;

    if (focus === "detail" && detail) {
      if (awaitConfirm) {
        if (input === "y" || input === "Y") {
          void runBuy();
          return;
        }
        if (input === "n" || input === "N") {
          setAwaitConfirm(false);
        }
        return;
      }
      if (input === "b") {
        const missing = contactMissingFields(detail.contact);
        if (!detail.namecheapConnected) {
          setDetail({ ...detail, error: "Connect Namecheap first." });
          return;
        }
        if (!detail.quote?.buyable) {
          setDetail({ ...detail, error: "Domain is not buyable on Namecheap." });
          return;
        }
        if (missing.length) {
          setDetail({ ...detail, error: `Set registrant contact first: uplink domains contact set` });
          return;
        }
        const price = detail.quote.priceUsd ?? 0;
        const balance = detail.balance?.available ?? 0;
        if (balance + 0.001 < price) {
          setDetail({
            ...detail,
            error: `Insufficient balance (need ~$${price.toFixed(2)}, have $${balance.toFixed(2)}). Press f to add funds.`,
          });
          return;
        }
        setAwaitConfirm(true);
        return;
      }
      if (input === "f") {
        void runFund();
        return;
      }
      if (input === "o") {
        const url = namecheapCartUrl(detail.domain, 1);
        openInBrowser(url);
        setDetail({ ...detail, message: `Opened cart: ${url}` });
      }
      return;
    }

    const specialMode = parsed.mode === "browse" || parsed.mode === "related";

    if (specialMode && focus === "search") {
      if (parsed.mode === "browse" && key.upArrow) {
        setStrategyIndex((i) => (i + BROWSE_STRATEGIES.length - 1) % BROWSE_STRATEGIES.length);
        return;
      }
      if (parsed.mode === "browse" && key.downArrow) {
        setStrategyIndex((i) => (i + 1) % BROWSE_STRATEGIES.length);
        return;
      }
      if (key.return) {
        startOrStopScan();
        return;
      }
    }

    if (key.tab && plainSearch) {
      setShowTaken((prev) => !prev);
      return;
    }
    if (input === "m" && focus === "list" && plainSearch) {
      setMoreTlds((prev) => !prev);
      return;
    }
    if (key.downArrow) {
      if (visible.length) moveSelection(1);
      return;
    }
    if (key.upArrow) {
      if (visible.length) moveSelection(-1);
      return;
    }
    if (key.return) {
      if (focus === "list" && visible[selected]) {
        void openDetail(visible[selected]);
        return;
      }
      if (focus === "search" && visible.length) {
        setFocus("list");
      }
      return;
    }
    if (focus === "search") {
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl) {
        setQuery((q) => q + input);
      }
      return;
    }
    if (focus === "list" && input && !key.ctrl) {
      setFocus("search");
      setQuery((q) => q + input);
    }
  });

  if (detail) {
    return (
      <DomainDetail
        state={detail}
        actionHint={
          busy
            ? "Working…"
            : awaitConfirm
              ? `Buy ${detail.domain} for ${formatMoney(detail.quote?.priceUsd)}? [y/n]`
              : "Select an action"
        }
      />
    );
  }

  const pending = liveRows.some((row) => row.status === "checking");
  let hint = "esc/← back";
  if (parsed.mode === "browse") {
    hint = `↑↓ strategy · enter ${scan.state.running ? "stops" : "starts"} the scan · enter on a result for details · ${hint}`;
  } else if (parsed.mode === "related") {
    hint = `enter ${scan.state.running ? "stops" : "starts"} the scan · enter on a result for details · ${hint}`;
  } else {
    hint =
      `${rows.length > 0 && !pending ? `${available.length} of ${rows.length} free · ` : ""}` +
      `↑↓ select · enter details · m ${moreTlds ? "fewer TLDs" : "more TLDs"} · tab taken · ${hint}`;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={crumb} />
      {!namecheapConnected && (
        <Panel marginTop={1}>
          <Text dimColor>Availability only — connect Namecheap (or another registrar) for price and buy.</Text>
        </Panel>
      )}
      <Box marginTop={1}>
        <SearchField value={query} placeholder={SEARCH_PLACEHOLDER} focused={focus === "search"} />
      </Box>

      {parsed.mode === "related" && (
        <Panel marginTop={1}>
          <Text>
            words related to <Text bold>{parsed.word}</Text>{" "}
            <Text dimColor>
              · scanning under {parsed.tld ? `.${parsed.tld}` : `${DEFAULT_TLDS.length} TLDs`}
            </Text>
          </Text>
          {related.loading && <Text dimColor>fetching related words…</Text>}
          {related.error && <Text color="red">{related.error}</Text>}
          {related.words.length > 0 && (
            <Text dimColor wrap="wrap">
              {related.words.join(" · ")}
            </Text>
          )}
        </Panel>
      )}

      {parsed.mode === "browse" && (
        <Panel marginTop={1}>
          <Text>
            browsing <Text bold>.{parsed.tld}</Text>
          </Text>
          {BROWSE_STRATEGIES.map((strategy, i) => (
            <Text
              key={strategy.id}
              bold={i === strategyIndex}
              inverse={focus === "search" && i === strategyIndex}
              dimColor={i !== strategyIndex}
            >
              {i === strategyIndex ? " › " : "   "}
              {strategy.label}
              {focus === "search" && i === strategyIndex ? "\u2800" : ""}
            </Text>
          ))}
        </Panel>
      )}

      {(scan.state.running || scan.state.done || scan.state.error) &&
        (parsed.mode === "browse" || parsed.mode === "related") && (
          <Panel marginTop={1}>
            <Text dimColor>
              {scan.state.checked}/{scan.state.total || "…"} checked · {scan.state.found.length} available
              {scan.state.skipped > 0 ? ` · ${scan.state.skipped} skipped` : ""}
              {scan.state.running ? " · scanning" : scan.state.done ? " · done" : ""}
            </Text>
            {scan.state.error && <Text color="red">{scan.state.error}</Text>}
          </Panel>
        )}

      {visible.length > 0 && (
        <Panel marginTop={1}>
          <Text dimColor>
            {parsed.mode === "browse" || parsed.mode === "related"
              ? "available"
              : moreTlds
                ? "results · more TLDs"
                : "results"}
          </Text>
          {visible.map((row, index) => (
            <ResultLine key={row.domain} row={row} active={focus === "list" && index === selected} />
          ))}
        </Panel>
      )}
      {plainSearch && !showTaken && taken.length > 0 && (
        <Panel marginTop={1}>
          <Text dimColor>{taken.length} taken · tab to show</Text>
        </Panel>
      )}
      <KeyBar hint={hint} />
    </Box>
  );
}

export async function runDomainSearch(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "Domain search needs a terminal. Agents: uplink domains search myapp --json";
  }
  const nested = process.env.UPLINK_TUI_ALT === "1";
  prepareStdinForInk();
  enterTuiScreen();
  try {
    const instance = render(<DomainSearchApp />, {
      stdin: process.stdin,
      stdout: process.stdout,
      exitOnCtrlC: true,
    });
    await instance.waitUntilExit();
    instance.unmount();
    return "";
  } finally {
    if (!nested) leaveTuiScreen();
  }
}
