import { clearScreen } from "./io";
import { colorBold, colorCyan, colorDim, colorGreen, colorRed } from "./colors";
import { DEFAULT_MENU_MESSAGE, type MenuChoice } from "./types";

export type RenderArgs = {
  banner: string;
  cachedRelayStatus: string;
  cachedActiveTunnels?: string;
  menuPath: string[];
  currentMenu: MenuChoice[];
  selected: number;
  message: string;
  busy: boolean;
  showStatusIndicator: boolean;
};

export function renderMenu(args: RenderArgs) {
  const {
    banner,
    cachedRelayStatus,
    cachedActiveTunnels,
    menuPath,
    currentMenu,
    selected,
    message,
    busy,
    showStatusIndicator,
  } = args;

  clearScreen();
  console.log();
  console.log(banner);

  // Status indicator below logo (only on main menu)
  if (showStatusIndicator && cachedRelayStatus) {
    const statusIndicator = cachedRelayStatus.includes("ok") ? colorGreen("›") : colorRed("›");
    const statusText = cachedRelayStatus.includes("ok") ? "connected" : "offline";
    console.log(statusIndicator + colorDim(" " + statusText));
  }
  console.log();

  console.log();

  // Breadcrumb navigation
  if (menuPath.length > 0) {
    const breadcrumb = menuPath
      .map((p, i) => (i === menuPath.length - 1 ? colorBold(p) : colorDim(p)))
      .join(colorDim(" › "));
    console.log(breadcrumb);
    console.log();
  }

  // Menu items - simple list style
  currentMenu.forEach((choice, idx) => {
    const isSelected = idx === selected;

    // Clean up labels - remove emojis for cleaner look
    const cleanLabel = choice.label
      .replace(/^🚀\s*/, "")
      .replace(/^⚠️\s*/, "⚠ ")
      .replace(/^✅\s*/, "")
      .replace(/^❌\s*/, "");

    // Has submenu indicator
    const hasSubmenu = !!choice.subMenu;
    const suffix = hasSubmenu ? " ›" : "";

    // Style based on selection
    let line: string;
    if (isSelected) {
      if (cleanLabel.toLowerCase().includes("exit")) {
        line = colorDim("› " + cleanLabel + suffix);
      } else if (cleanLabel.toLowerCase().includes("stop all") || cleanLabel.toLowerCase().includes("⚠")) {
        line = colorRed("› " + cleanLabel + suffix);
      } else {
        line = colorBold("› " + cleanLabel + suffix);
      }
    } else {
      if (cleanLabel.toLowerCase().includes("exit")) {
        line = colorDim("  " + cleanLabel + suffix);
      } else if (cleanLabel.toLowerCase().includes("stop all") || cleanLabel.toLowerCase().includes("⚠")) {
        line = colorDim("  ") + colorRed(cleanLabel + suffix);
      } else {
        line = colorDim("  " + cleanLabel + suffix);
      }
    }

    console.log(line);
  });

  // Active tunnels list (only on main menu)
  if (showStatusIndicator && cachedActiveTunnels) {
    console.log();
    console.log(cachedActiveTunnels);
  }

  // Message area
  if (busy) {
    console.log();
    console.log(colorDim("Working..."));
  } else if (message && message !== DEFAULT_MENU_MESSAGE) {
    console.log();
    // Format multi-line messages nicely
    const lines = message.split("\n");
    lines.forEach((line) => {
      // Color success/error indicators
      const styledLine = line
        .replace(/^✓/, colorGreen("✓"))
        .replace(/^✗/, colorRed("✗"))
        .replace(/^→/, colorCyan("→"));
      console.log(styledLine);
    });
  }

  // Footer hints
  console.log();
  console.log(colorDim("↑↓ navigate  ↵ select  ^C exit"));
}

