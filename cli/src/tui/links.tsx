import { Text } from "ink";
import { sanitizeForTerminal } from "../utils/sanitize";

const URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/, "");
}

/** OSC 8 hyperlink. Ink preserves OSC sequences so Cursor/VS Code can click them. */
export function terminalHyperlink(label: string, href: string): string {
  return `\u001b]8;;${href}\u0007${label}\u001b]8;;\u0007`;
}

export function extractHttpUrls(text: string): string[] {
  const found = sanitizeForTerminal(text).match(URL_RE) ?? [];
  return [...new Set(found.map(trimUrl))];
}

/** Prefer a pretty alias URL when both the ephemeral and alias links are present. */
export function preferredShareUrl(urls: string[]): string | undefined {
  return urls.find((url) => /^https:\/\/[^/]+\.uplink\.spot\/?$/i.test(url) && !url.includes(".x."))
    ?? urls.find((url) => url.includes("uplink.spot"))
    ?? urls[0];
}

export function LinkifiedLine({
  line,
  color,
  dim,
}: {
  line: string;
  color?: string;
  dim?: boolean;
}) {
  const text = sanitizeForTerminal(line);
  const parts: Array<{ key: string; value: string; href?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ key: `t${last}`, value: text.slice(last, index) });
    }
    const raw = match[0];
    const href = trimUrl(raw);
    parts.push({ key: `u${index}`, value: href, href });
    if (raw.length > href.length) {
      parts.push({ key: `p${index}`, value: raw.slice(href.length) });
    }
    last = index + raw.length;
  }
  if (last < text.length) {
    parts.push({ key: `t${last}`, value: text.slice(last) });
  }

  if (parts.length === 0) {
    return (
      <Text color={color} dimColor={dim} wrap="truncate">
        {text || " "}
      </Text>
    );
  }

  return (
    <Text wrap="truncate">
      {parts.map((part) =>
        part.href ? (
          <Text key={part.key} color="cyan" underline>
            {terminalHyperlink(part.value, part.href)}
          </Text>
        ) : (
          <Text key={part.key} color={color} dimColor={dim}>
            {part.value}
          </Text>
        )
      )}
    </Text>
  );
}
