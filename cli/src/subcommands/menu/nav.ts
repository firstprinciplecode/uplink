import type { MenuChoice } from "./types";

export type MenuNavState = {
  menuStack: MenuChoice[][];
  menuPath: string[];
  selected: number;
};

export function initNav(mainMenu: MenuChoice[]): MenuNavState {
  return { menuStack: [mainMenu], menuPath: [], selected: 0 };
}

export function getCurrentMenu(nav: MenuNavState): MenuChoice[] {
  return nav.menuStack[nav.menuStack.length - 1] || [];
}

export function moveSelection(nav: MenuNavState, delta: -1 | 1): MenuNavState {
  const current = getCurrentMenu(nav);
  if (current.length === 0) return nav;
  const nextSelected = (nav.selected + delta + current.length) % current.length;
  return { ...nav, selected: nextSelected };
}

export function pushSubMenu(nav: MenuNavState, choice: MenuChoice): MenuNavState {
  if (!choice.subMenu) return nav;
  return {
    menuStack: [...nav.menuStack, choice.subMenu],
    menuPath: [...nav.menuPath, choice.label],
    selected: 0,
  };
}

export function popMenu(nav: MenuNavState): MenuNavState {
  if (nav.menuStack.length <= 1) return nav;
  return {
    menuStack: nav.menuStack.slice(0, -1),
    menuPath: nav.menuPath.slice(0, -1),
    selected: 0,
  };
}

