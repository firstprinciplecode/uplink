import type { MenuChoice } from "../subcommands/menu/types";
import type { MenuStatus } from "./App";
import { cleanLabel } from "./format";
import { fetchAppLogs } from "./snapshot";

export function withLiveApps(tree: MenuChoice[], status: MenuStatus): MenuChoice[] {
  return tree.map((item) => {
    if (!item.subMenu || cleanLabel(item.label) !== "Hosting") return item;
    const rest = item.subMenu.filter((choice) => cleanLabel(choice.label) !== "Apps");
    const appsMenu: MenuChoice = {
      label: "Apps",
      subMenu:
        status.apps.length > 0
          ? status.apps.map((app) => ({
              label: app.name,
              inspect: { kind: "app", id: app.id, url: app.url, createdAt: app.createdAt },
              subMenu: [
                {
                  label: "Logs",
                  action: () => fetchAppLogs(app.id),
                },
              ],
            }))
          : [{ label: "No apps yet", action: async () => "No hosted apps." }],
    };
    return { ...item, subMenu: [appsMenu, ...rest] };
  });
}

export function resolveStack(tree: MenuChoice[], titles: string[]): MenuChoice[][] {
  const stack: MenuChoice[][] = [tree];
  let current = tree;
  for (let i = 1; i < titles.length; i += 1) {
    const found = current.find((choice) => cleanLabel(choice.label) === titles[i]);
    if (!found?.subMenu) break;
    stack.push(found.subMenu);
    current = found.subMenu;
  }
  return stack;
}
