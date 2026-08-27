export type MenuInspect = {
  kind: "app";
  id: string;
  url?: string;
  createdAt?: string;
};

export type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
  inspect?: MenuInspect;
};

export const DEFAULT_MENU_MESSAGE = "Use ↑/↓ and Enter. ← to go back. Ctrl+C to quit.";

