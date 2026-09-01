import readline from "readline";
import { colorBold } from "./colors";

const choiceTokenRegex = /\((?:Y\/n|y\/N|y\/n|Y\/N)\)/g;
const backTokenRegex = /"back"|'back'/g;

function stylePrompt(question: string): string {
  return question
    .replace(choiceTokenRegex, (match) => colorBold(match))
    .replace(backTokenRegex, (match) => colorBold(match));
}

export function prepareStdinForPrompt(): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  process.stdin.ref();
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  drainStdin();
}

/** Drop a leftover Enter from Ink so readline does not auto-answer the next prompt. */
function drainStdin(): void {
  const stdin = process.stdin as NodeJS.ReadStream & { read?: () => unknown };
  if (typeof stdin.read !== "function") return;
  try {
    let chunk: unknown;
    while ((chunk = stdin.read()) !== null) {
      void chunk;
    }
  } catch {
    /* ignore */
  }
}

function promptLineReadline(question: string): Promise<string> {
  return new Promise((resolve) => {
    prepareStdinForPrompt();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(stylePrompt(question), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Line editor: enter submits, esc / ← (empty) / ctrl+c (in the TUI) cancel as "back". */
function promptLineRaw(question: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    prepareStdinForPrompt();
    process.stdout.write(stylePrompt(question));
    let buf = "";
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    const finish = (value: string) => {
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf8");
      if (str === "\u0003") {
        if (process.env.UPLINK_TUI_ALT === "1") {
          finish("back");
          return;
        }
        finish("");
        process.exit(130);
        return;
      }
      if (str === "\r" || str === "\n") {
        finish(buf);
        return;
      }
      if (str === "\u001b" || str === "\u001b\u001b") {
        finish("back");
        return;
      }
      if (str === "\u001b[D" && buf.length === 0) {
        finish("back");
        return;
      }
      if (str.startsWith("\u001b")) return;
      if (str === "\u007f" || str === "\b") {
        if (!buf.length) return;
        buf = buf.slice(0, -1);
        process.stdout.write("\b \b");
        return;
      }
      buf += str;
      process.stdout.write(mask ? "*".repeat(str.length) : str);
    };
    process.stdin.on("data", onData);
  });
}

export function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return promptLineReadline(question);
  return promptLineRaw(question);
}

/** Like promptLine, but echoes `*` so secrets don't land on screen or in scrollback. */
export function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return promptLineReadline(question);
  return promptLineRaw(question, true);
}

export function isBackInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "back" || normalized === "b";
}

export async function promptLineWithBack(question: string): Promise<string | null> {
  const answer = await promptLine(question);
  return isBackInput(answer) ? null : answer;
}

export function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[0f");
}

export function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/** Pause stdin so the next Ink render (readable-mode) can actually receive keys. */
export function prepareStdinForInk(): void {
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  try {
    process.stdin.setEncoding(null as unknown as BufferEncoding);
  } catch {
    /* ignore */
  }
  drainStdin();
}

export function restoreRawMode() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

const ALT_ENV = "UPLINK_TUI_ALT";
let ownsAltScreen = false;
let altExitHooked = false;

/** Full-screen TUI: one frame, no stacked copies, shell restored on quit. */
export function enterTuiScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
  if (process.env[ALT_ENV] === "1") {
    process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
    return;
  }
  ownsAltScreen = true;
  process.env[ALT_ENV] = "1";
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  if (altExitHooked) return;
  altExitHooked = true;
  const restore = () => leaveTuiScreen();
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}

export function leaveTuiScreen(): void {
  if (!ownsAltScreen || !process.stdout.isTTY) return;
  ownsAltScreen = false;
  delete process.env[ALT_ENV];
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}
