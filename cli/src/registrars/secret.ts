import { createInterface } from "readline";

export function readEnvValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is empty or missing`);
  return value;
}

/** Hidden prompt. Agents should use --token-env instead so the secret never hits argv. */
export async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (value) => {
        rl.close();
        resolve(value);
      });
    });
    return answer.trim();
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    };
    stdin.on("data", onData);
  });
}

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
