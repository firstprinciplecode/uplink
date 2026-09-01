import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { MenuChoice } from "../subcommands/menu/types";
import { HomeStatus } from "./HomeStatus";
import { AppInspector } from "./AppInspector";
import { Wordmark } from "./brand";
import { NoticePager, noticeNeedsPager } from "./NoticePager";
import { cleanLabel } from "./format";
import { sanitizeForTerminal } from "../utils/sanitize";
import { DomainSearchApp } from "./DomainSearch";
import { AttachAppScreen } from "./AttachApp";
import { MyDomainsScreen } from "./MyDomains";
import { Panel, KeyBar, MenuRow } from "./chrome";
import { openInBrowser } from "../utils/open-browser";
import { copyToClipboard } from "../utils/copy-clipboard";

export type TunnelLine = { url: string; port: number };

export type MenuStatus = {
  connected: boolean;
  latencyMs: number | null;
  tunnels: TunnelLine[];
  apps: { name: string; id: string; url?: string; createdAt?: string }[];
  providers: string[];
  storageUsedBytes: number;
  storageLimitBytes: number;
  appLimit: number;
  alwaysOn: boolean;
  idleMinutes: number | null;
};

export type MenuOutcome =
  | { kind: "quit" }
  | {
      kind: "action";
      action: () => Promise<string>;
      isExit: boolean;
      stack: MenuChoice[][];
      titles: string[];
      selected: number;
    };

function isDanger(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("stop all") || lower.includes("⚠") || lower.includes("delete");
}

function isExitLabel(label: string): boolean {
  return label.toLowerCase() === "exit";
}

function noticeColor(line: string): string | undefined {
  if (line.startsWith("Error:") || line.startsWith("✗")) return "red";
  if (line.startsWith("✓")) return "green";
  return undefined;
}

export function MenuApp({
  tree,
  status,
  message,
  initialStack,
  initialTitles,
  initialSelected,
  onOutcome,
}: {
  tree: MenuChoice[];
  status: MenuStatus;
  message: string;
  initialStack: MenuChoice[][];
  initialTitles: string[];
  initialSelected: number;
  onOutcome: (outcome: MenuOutcome) => void;
}) {
  const { exit } = useApp();
  const [stack, setStack] = useState<MenuChoice[][]>(initialStack);
  const [titles, setTitles] = useState<string[]>(initialTitles);
  const [cursors, setCursors] = useState<number[]>(() =>
    initialStack.map((_, i) => (i === initialStack.length - 1 ? initialSelected : 0))
  );
  const [notice, setNotice] = useState(message);
  const [page, setPage] = useState<{ title: string; body: string } | null>(null);
  const [screen, setScreen] = useState<"menu" | "find-domain" | "attach-app" | "my-domains">("menu");
  const inputArmed = useRef(false);

  useEffect(() => {
    inputArmed.current = false;
    const timer = setTimeout(() => {
      inputArmed.current = true;
    }, 180);
    return () => clearTimeout(timer);
  }, [screen, page, notice]);

  const current = (stack[stack.length - 1] ?? tree).filter(Boolean);
  const atRoot = stack.length === 1;
  const crumb = titles.slice(1).join(" › ");
  const selected = Math.min(cursors[cursors.length - 1] ?? 0, Math.max(0, current.length - 1));
  const selectedChoice = current[selected];
  const inspecting = Boolean(selectedChoice?.inspect);
  const pager = Boolean(notice && noticeNeedsPager(notice));
  const inMenu = screen === "menu" && !pager;

  const setCursor = (index: number) => {
    setCursors((prev) => {
      const next = prev.length === stack.length ? [...prev] : stack.map((_, i) => prev[i] ?? 0);
      next[next.length - 1] = index;
      return next;
    });
  };

  const finish = (outcome: MenuOutcome) => {
    onOutcome(outcome);
    exit();
  };

  const goBack = () => {
    if (page) {
      setPage(null);
      return;
    }
    if (notice) {
      setNotice("");
      return;
    }
    if (atRoot) {
      finish({ kind: "quit" });
      return;
    }
    setStack((prev) => prev.slice(0, -1));
    setTitles((prev) => prev.slice(0, -1));
    setCursors((prev) => prev.slice(0, -1));
  };

  const activateChoice = (choice: MenuChoice | undefined) => {
    if (!choice) return;
    if (choice.subMenu && choice.subMenu.length > 0) {
      setStack((prev) => [...prev, choice.subMenu!]);
      setTitles((prev) => [...prev, cleanLabel(choice.label)]);
      setCursors((prev) => [...prev, 0]);
      return;
    }
    if (choice.page) {
      setNotice("");
      setPage({ title: cleanLabel(choice.label), body: choice.page });
      return;
    }
    if (choice.screen === "find-domain") {
      setNotice("");
      inputArmed.current = false;
      setScreen("find-domain");
      return;
    }
    if (choice.screen === "attach-app") {
      setNotice("");
      inputArmed.current = false;
      setScreen("attach-app");
      return;
    }
    if (choice.screen === "my-domains") {
      setNotice("");
      inputArmed.current = false;
      setScreen("my-domains");
      return;
    }
    if (choice.href) {
      openInBrowser(choice.href);
      setNotice(`↗  ${choice.href}`);
      return;
    }
    if (choice.copy) {
      copyToClipboard(choice.copy);
      setNotice(`copied  ${choice.copy}`);
      return;
    }
    if (choice.action) {
      finish({
        kind: "action",
        action: choice.action,
        isExit: isExitLabel(choice.label),
        stack,
        titles,
        selected,
      });
    }
  };

  useInput(
    (_input, key) => {
      if (!inputArmed.current) return;
      if (key.escape || key.leftArrow) {
        goBack();
        return;
      }
      if (page) {
        if (key.return) goBack();
        return;
      }
      if (_input === "q" && atRoot && !notice) {
        finish({ kind: "quit" });
        return;
      }
      if (!current.length) return;
      if (key.upArrow) {
        setCursor((selected - 1 + current.length) % current.length);
        return;
      }
      if (key.downArrow) {
        setCursor((selected + 1) % current.length);
        return;
      }
      if (/^[1-9]$/.test(_input) && !notice) {
        const index = Number(_input) - 1;
        if (current[index]) {
          setCursor(index);
          activateChoice(current[index]);
        }
        return;
      }
      if (key.return || key.rightArrow) {
        if (notice) {
          setNotice("");
          return;
        }
        activateChoice(current[selected]);
      }
    },
    { isActive: inMenu }
  );

  if (screen === "find-domain") {
    return (
      <DomainSearchApp
        crumb={crumb ? `${crumb} › Find` : "Find a domain"}
        onExit={() => {
          inputArmed.current = false;
          setScreen("menu");
        }}
      />
    );
  }

  if (screen === "attach-app") {
    return (
      <AttachAppScreen
        crumb={crumb ? `${crumb} › Attach` : "Attach to app"}
        onExit={() => {
          inputArmed.current = false;
          setScreen("menu");
        }}
      />
    );
  }

  if (screen === "my-domains") {
    return (
      <MyDomainsScreen
        crumb={crumb ? `${crumb} › My domains` : "My domains"}
        onExit={() => {
          inputArmed.current = false;
          setScreen("menu");
        }}
      />
    );
  }

  if (pager && notice) {
    return (
      <NoticePager
        title={crumb || "Output"}
        text={notice}
        onClose={() => setNotice("")}
      />
    );
  }

  const pageCrumb = [crumb, page?.title].filter(Boolean).join(" › ");

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark
        connected={atRoot && !page ? status.connected : undefined}
        tunnels={atRoot && !page ? status.tunnels.length : undefined}
        apps={atRoot && !page ? status.apps.length : undefined}
        crumb={page ? pageCrumb || page.title : atRoot ? undefined : crumb || undefined}
      />

      {page ? (
        <Panel marginTop={1}>
          {sanitizeForTerminal(page.body).split("\n").map((line, i) => (
            <Text key={i} color={noticeColor(line)} dimColor={!noticeColor(line)}>
              {line || " "}
            </Text>
          ))}
        </Panel>
      ) : (
        <Panel marginTop={1} paddingX={0}>
          {current.map((choice, i) => {
            const active = i === selected;
            const label = cleanLabel(choice.label);
            const suffix = choice.subMenu ? " ▸" : choice.href ? " ↗" : "";
            const danger = isDanger(label);
            const exitItem = isExitLabel(label);
            return (
              <MenuRow
                key={`${label}-${i}`}
                index={i + 1}
                label={label}
                active={active}
                suffix={suffix}
                danger={danger}
                dim={exitItem}
              />
            );
          })}
        </Panel>
      )}

      {!page && atRoot ? <HomeStatus status={status} /> : null}

      {!page && inspecting ? <AppInspector inspect={selectedChoice?.inspect} /> : null}

      {!page && notice ? (
        <Panel marginTop={1}>
          {sanitizeForTerminal(notice).split("\n").map((line, i) => (
            <Text key={i} color={noticeColor(line)} dimColor={!noticeColor(line)}>
              {line || " "}
            </Text>
          ))}
        </Panel>
      ) : null}

      <KeyBar
        hint={
          page || notice
            ? "esc/←/enter back"
            : inspecting
              ? "↑↓ inspect · ↵ open · esc/← back"
              : atRoot
                ? "↑↓ 1-9 enter · esc/←/q quit"
                : "↑↓ 1-9 enter · esc/← back"
        }
      />
    </Box>
  );
}
