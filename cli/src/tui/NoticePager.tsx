import { Box, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sanitizeForTerminal } from "../utils/sanitize";
import { Wordmark } from "./brand";
import { Panel, KeyBar } from "./chrome";
import { extractHttpUrls, LinkifiedLine, preferredShareUrl } from "./links";
import { openInBrowser } from "../utils/open-browser";
import { copyToClipboard } from "../utils/copy-clipboard";

const PAGER_MIN_LINES = 8;

export function noticeNeedsPager(text: string): boolean {
  return sanitizeForTerminal(text).split("\n").length > PAGER_MIN_LINES;
}

function lineColor(line: string): string | undefined {
  if (line.startsWith("Error:") || line.startsWith("✗")) return "red";
  if (line.startsWith("✓")) return "green";
  return undefined;
}

export function NoticePager({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  const { stdout } = useStdout();
  const lines = useMemo(() => sanitizeForTerminal(text).split("\n"), [text]);
  const termRows = stdout?.rows ?? 24;
  const viewH = Math.max(8, termRows - 6);
  const maxScroll = Math.max(0, lines.length - viewH);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    setScroll(0);
  }, [text]);

  const move = useCallback(
    (delta: number) => {
      setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta)));
    },
    [maxScroll]
  );

  const shareUrl = preferredShareUrl(extractHttpUrls(text));

  useInput((input, key) => {
    if (shareUrl && (input === "o" || key.return || key.rightArrow)) {
      openInBrowser(shareUrl);
      return;
    }
    if (shareUrl && input === "c") {
      copyToClipboard(shareUrl);
      return;
    }
    if (key.escape || key.leftArrow || key.return) {
      onClose();
      return;
    }
    if (key.upArrow || input === "k") {
      move(-1);
      return;
    }
    if (key.downArrow || input === "j") {
      move(1);
      return;
    }
    if (key.pageUp || input === "b") {
      move(-viewH);
      return;
    }
    if (key.pageDown || input === " " || input === "f") {
      move(viewH);
      return;
    }
    if (key.home || input === "g") {
      setScroll(0);
      return;
    }
    if (key.end || input === "G") {
      setScroll(maxScroll);
    }
  });

  const slice = lines.slice(scroll, scroll + viewH);
  const end = Math.min(lines.length, scroll + slice.length);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Wordmark crumb={title} />
      <Panel marginTop={1}>
        <Box flexDirection="column" height={viewH} overflow="hidden">
          {slice.map((line, i) => {
            const color = lineColor(line);
            return (
              <LinkifiedLine key={scroll + i} line={line} color={color} dim={!color} />
            );
          })}
        </Box>
      </Panel>
      <KeyBar
        hint={
          [
            maxScroll > 0 ? `${scroll + 1}–${end} of ${lines.length}  ·  ↑↓  ·  space page` : null,
            shareUrl ? "↵/o open url · c copy" : null,
            "esc/← back",
          ]
            .filter(Boolean)
            .join("  ·  ")
        }
      />
    </Box>
  );
}
