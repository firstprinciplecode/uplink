export type FactRow = { label: string; value: string };

export type MenuInspect =
  | { kind: "app"; id: string; url?: string; createdAt?: string }
  | { kind: "facts"; title: string; rows: FactRow[] };

export type MenuScreen =
  | "find-domain"
  | "attach-app"
  | "verify-dns"
  | "detach-domain"
  | "my-domains";

export type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
  inspect?: MenuInspect;
  /** Stay inside the current Ink tree (do not unmount the menu). */
  screen?: MenuScreen;
  /** Static page — stay in Ink; esc/← returns to the parent list. */
  page?: string;
  /** Open in the default browser without leaving the menu. */
  href?: string;
  /** Copy this string to the clipboard without leaving the menu. */
  copy?: string;
};

export const DEFAULT_MENU_MESSAGE = "Use ↑/↓ and Enter. ← to go back. Ctrl+C to quit.";

