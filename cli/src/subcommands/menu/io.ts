import readline from "readline";
import { colorBold } from "./colors";

const choiceTokenRegex = /\((?:Y\/n|y\/N|y\/n|Y\/N)\)/g;
const backTokenRegex = /"back"|'back'/g;

function stylePrompt(question: string): string {
  return question
    .replace(choiceTokenRegex, (match) => colorBold(match))
    .replace(backTokenRegex, (match) => colorBold(match));
}

export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
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
