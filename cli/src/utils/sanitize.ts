// Strip C0/C1 control characters (including ANSI escape sequences) from strings
// that originate from the server or a registrar before printing them to the
// terminal. Without this, an attacker-controlled app name, domain, or error body
// could inject escape sequences to rewrite the terminal, spoof prompts, or hide
// output. Newlines and tabs are preserved so multi-line messages still render.
export function sanitizeForTerminal(input: string): string {
  // eslint-disable-next-line no-control-regex
  return String(input).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
