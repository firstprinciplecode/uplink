import { useEffect } from "react";

export type TerminalMouseEvent =
  | { type: "wheel"; direction: "up" | "down" }
  | { type: "click"; x: number; y: number; button: "left" };

const ENABLE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

/** SGR mouse: ESC [ < btn ; x ; y M/m  (1-based x/y) */
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function parseEvents(chunk: string): TerminalMouseEvent[] {
  const events: TerminalMouseEvent[] = [];
  for (const match of chunk.matchAll(SGR)) {
    const btn = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const release = match[4] === "m";
    // Wheel buttons (SGR): 64 up, 65 down (sometimes +32 for motion)
    if (btn === 64 || btn === 96) {
      events.push({ type: "wheel", direction: "up" });
      continue;
    }
    if (btn === 65 || btn === 97) {
      events.push({ type: "wheel", direction: "down" });
      continue;
    }
    // Left button release = click
    if (release && (btn === 0 || btn === 32)) {
      events.push({ type: "click", x, y, button: "left" });
    }
  }
  return events;
}

/**
 * Best-effort terminal mouse tracking (wheel + left click).
 * Callers should keep a useInput handler active so escape sequences are consumed.
 */
export function useTerminalMouse(onEvent: (event: TerminalMouseEvent) => void, active = true): void {
  useEffect(() => {
    if (!active || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const stdin = process.stdin;
    process.stdout.write(ENABLE);
    const onData = (buf: Buffer | string) => {
      const text = typeof buf === "string" ? buf : buf.toString("utf8");
      for (const event of parseEvents(text)) onEvent(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      try {
        process.stdout.write(DISABLE);
      } catch {
        /* ignore */
      }
    };
  }, [onEvent, active]);
}
