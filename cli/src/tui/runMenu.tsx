import { render } from "ink";
import { MenuApp, type MenuOutcome, type MenuStatus } from "./App";
import type { MenuChoice } from "../subcommands/menu/types";
import { prepareStdinForPrompt } from "../subcommands/menu/io";
import { resolveStack, withLiveApps } from "./liveTree";

export async function runInkMenu(opts: {
  tree: MenuChoice[];
  getStatus: () => Promise<MenuStatus>;
}): Promise<void> {
  let message = "";
  let titles = ["UPLINK"];
  let selected = 0;

  while (true) {
    const status = await opts.getStatus();
    const tree = withLiveApps(opts.tree, status);
    const stack = resolveStack(tree, titles);
    let outcome: MenuOutcome = { kind: "quit" };
    const instance = render(
      <MenuApp
        tree={tree}
        status={status}
        message={message}
        initialStack={stack}
        initialTitles={titles}
        initialSelected={Math.min(selected, (stack[stack.length - 1]?.length || 1) - 1)}
        onOutcome={(next) => {
          outcome = next;
        }}
      />
    );
    await instance.waitUntilExit();
    instance.unmount();
    prepareStdinForPrompt();

    if (outcome.kind !== "action") return;

    titles = outcome.titles;
    selected = outcome.selected;

    if (outcome.isExit) {
      try {
        await outcome.action();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      message = (await outcome.action()) || "";
    } catch (error) {
      message = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
