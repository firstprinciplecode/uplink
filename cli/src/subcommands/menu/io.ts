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

export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    prepareStdinForPrompt();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(stylePrompt(question), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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

export function restoreRawMode() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}
