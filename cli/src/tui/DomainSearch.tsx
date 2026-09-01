import { Box, Text, useApp, useInput, render } from "ink";
import { Wordmark } from "./brand";
import { Panel, SearchField, KeyBar } from "./chrome";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicAvailability } from "../utils/domain-availability";
import { expandDomainQuery, type SearchTldSet } from "../utils/domain-search";
import { checkDomainAvailability } from "../utils/domain-availability";
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

type Row = PublicAvailability | { domain: string; status: "checking" };
type Focus = "search" | "list" | "detail";

const DEBOUNCE_MS = 400;

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

  return rows;
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
  const rows = useLiveChecks(query, moreTlds ? "more" : "default");

  const available = rows.filter((row) => row.status === "available");
  const taken = rows.filter((row) => row.status === "taken");
  const rest = rows.filter((row) => row.status !== "taken");
  const visible = useMemo(() => {
    const base = showTaken ? [...rest, ...taken] : rest;
    return base;
  }, [rest, taken, showTaken]);

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

    if (key.tab) {
      setShowTaken((prev) => !prev);
      return;
    }
    if (input === "m" && focus === "list") {
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

  const pending = rows.some((row) => row.status === "checking");

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={crumb} />
      {!readRegistrarStore().namecheap && (
        <Panel marginTop={1}>
          <Text dimColor>Availability only — connect Namecheap (or another registrar) for price and buy.</Text>
        </Panel>
      )}
      <Box marginTop={1}>
        <SearchField
          value={query}
          placeholder="acme   or   acme.io"
          focused={focus === "search"}
        />
      </Box>
      {visible.length > 0 && (
        <Panel marginTop={1}>
          <Text dimColor>{moreTlds ? "results · more TLDs" : "results"}</Text>
          {visible.map((row, index) => {
            const active = focus === "list" && index === selected;
            return (
              <Text
                key={row.domain}
                inverse={active}
                color={active ? undefined : statusColor(row.status)}
                dimColor={!active && (row.status === "checking" || row.status === "taken")}
              >
                {active ? " › " : "   "}
                {statusGlyph(row.status)} {row.domain}
                {row.status === "taken" ? "  taken" : ""}
                {active ? " " : ""}
              </Text>
            );
          })}
        </Panel>
      )}
      {!showTaken && taken.length > 0 && (
        <Panel marginTop={1}>
          <Text dimColor>{taken.length} taken · tab to show</Text>
        </Panel>
      )}
      <KeyBar
        hint={
          `${rows.length > 0 && !pending ? `${available.length} of ${rows.length} free · ` : ""}` +
          `↑↓ select · enter details · m ${moreTlds ? "fewer TLDs" : "more TLDs"} · tab taken · esc/← back`
        }
      />
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
