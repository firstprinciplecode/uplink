export type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
};

export const DEFAULT_MENU_MESSAGE = "Use ↑/↓ and Enter. ← to go back. Ctrl+C to quit.";

