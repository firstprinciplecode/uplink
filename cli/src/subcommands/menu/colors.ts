// Color palette and helpers for the interactive menu UI.
// Claude Code-inspired - clean, minimal aesthetic
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  // Colors
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  // Bright variants
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightWhite: "\x1b[97m",
  brightBlue: "\x1b[94m",
  // 256 color for subtle tones
  softBlue: "\x1b[38;5;75m",
  softGray: "\x1b[38;5;245m",
  darkGray: "\x1b[38;5;240m",
};

export function colorCyan(text: string) {
  return `${c.brightCyan}${text}${c.reset}`;
}

export function colorYellow(text: string) {
  return `${c.yellow}${text}${c.reset}`;
}

export function colorGreen(text: string) {
  return `${c.brightGreen}${text}${c.reset}`;
}

export function colorDim(text: string) {
  return `${c.dim}${text}${c.reset}`;
}

export function colorBold(text: string) {
  return `${c.bold}${c.brightWhite}${text}${c.reset}`;
}

export function colorRed(text: string) {
  return `${c.red}${text}${c.reset}`;
}

export function colorMagenta(text: string) {
  return `${c.magenta}${text}${c.reset}`;
}

export function colorWhite(text: string) {
  return `${c.brightWhite}${text}${c.reset}`;
}

export function colorBlue(text: string) {
  return `${c.softBlue}${text}${c.reset}`;
}

export function colorSoftGray(text: string) {
  return `${c.softGray}${text}${c.reset}`;
}

export function colorAccent(text: string) {
  return `${c.brightBlue}${text}${c.reset}`;
}
