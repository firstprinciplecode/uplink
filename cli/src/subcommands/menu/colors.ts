// Color palette and helpers for the interactive menu UI.
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Colors
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  // Bright variants
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightWhite: "\x1b[97m",
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

export function colorWhite(text: string) {
  return `${c.brightWhite}${text}${c.reset}`;
}

export const ASCII_UPLINK = colorWhite([
  "██╗   ██╗██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗",
  "██║   ██║██╔══██╗██║     ██║████╗  ██║██║ ██╔╝",
  "██║   ██║██████╔╝██║     ██║██╔██╗ ██║█████╔╝ ",
  "██║   ██║██╔═══╝ ██║     ██║██║╚██╗██║██╔═██╗ ",
  "╚██████╔╝██║     ███████╗██║██║ ╚████║██║  ██╗",
  " ╚═════╝ ╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝",
].join("\n"));
