import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { MenuChoice } from "../subcommands/menu/types";
import { HomeStatus } from "./HomeStatus";
import { AppInspector } from "./AppInspector";
import { Wordmark } from "./brand";
import { cleanLabel } from "./format";
import { sanitizeForTerminal } from "../utils/sanitize";

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
  const [selected, setSelected] = useState(initialSelected);
  const [notice, setNotice] = useState(message);

  const current = stack[stack.length - 1] ?? tree;
  const atRoot = stack.length === 1;
  const crumb = titles.slice(1).join(" › ");
  const selectedChoice = current[selected];
  const inspecting = Boolean(selectedChoice?.inspect);

  const finish = (outcome: MenuOutcome) => {
    onOutcome(outcome);
    exit();
  };

  const goBack = () => {
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
    setSelected(0);
  };

  useInput((_input, key) => {
    if (key.escape || key.leftArrow) {
      goBack();
      return;
    }
    if (_input === "q" && atRoot && !notice) {
      finish({ kind: "quit" });
      return;
    }
    if (key.upArrow) {
      setSelected((i) => (i - 1 + current.length) % current.length);
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % current.length);
      return;
    }
    if (key.return) {
      if (notice) {
        setNotice("");
        return;
      }
      const choice = current[selected];
      if (!choice) return;
      if (choice.subMenu && choice.subMenu.length > 0) {
        setStack((prev) => [...prev, choice.subMenu!]);
        setTitles((prev) => [...prev, cleanLabel(choice.label)]);
        setSelected(0);
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
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark />
      {atRoot ? (
        <HomeStatus status={status} />
      ) : crumb ? (
        <Box marginTop={1}>
          <Text dimColor>{crumb}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={atRoot ? 1 : 1}>
        {current.map((choice, i) => {
          const active = i === selected;
          const label = cleanLabel(choice.label);
          const suffix = choice.subMenu ? " ›" : "";
          const danger = isDanger(label);
          const exitItem = isExitLabel(label);
          return (
            <Text
              key={`${label}-${i}`}
              bold={active && !exitItem}
              color={active && danger ? "red" : undefined}
              dimColor={!active || exitItem}
            >
              {active ? "› " : "  "}
              {label}
              {suffix}
            </Text>
          );
        })}
      </Box>

      {inspecting ? <AppInspector inspect={selectedChoice?.inspect} /> : null}

      {notice ? (
        <Box flexDirection="column" marginTop={1}>
          {sanitizeForTerminal(notice).split("\n").map((line, i) => (
            <Text key={i} color={noticeColor(line)} dimColor={!noticeColor(line)}>
              {line || " "}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {notice
            ? "enter/esc dismiss"
            : inspecting
              ? "↑↓ inspect · ↵ open · esc back"
              : atRoot
                ? "↑↓ enter · esc/q quit"
                : "↑↓ enter · esc back"}
        </Text>
      </Box>
    </Box>
  );
}
