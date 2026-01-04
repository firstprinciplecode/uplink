import { colorCyan, colorDim } from "./colors";

// Inline arrow-key selector (returns selected option, or null for "Back")
export type SelectOption = { label: string; value: string | number | null };

export async function inlineSelect(
  title: string,
  options: SelectOption[],
  includeBack: boolean = true
): Promise<{ index: number; value: string | number | null } | null> {
  return new Promise((resolve) => {
    // Add "Back" option if requested
    const allOptions = includeBack ? [...options, { label: "Back", value: null }] : options;

    let selected = 0;

    const renderSelector = () => {
      // Clear previous render (move cursor up and clear lines)
      const linesToClear = allOptions.length + 3;
      process.stdout.write(`\x1b[${linesToClear}A\x1b[0J`);

      console.log();
      console.log(colorDim(title));
      console.log();

      allOptions.forEach((opt, idx) => {
        const isLast = idx === allOptions.length - 1;
        const isSelected = idx === selected;
        const branch = isLast ? "└─" : "├─";

        let label: string;
        let branchColor: string;

        if (isSelected) {
          branchColor = colorCyan(branch);
          if (opt.label === "Back") {
            label = colorDim(opt.label);
          } else {
            label = colorCyan(opt.label);
          }
        } else {
          branchColor = colorDim(branch);
          if (opt.label === "Back") {
            label = colorDim(opt.label);
          } else {
            label = opt.label;
          }
        }

        console.log(`${branchColor} ${label}`);
      });
    };

    // Initial render - print blank lines first so we can clear them
    console.log();
    console.log(colorDim(title));
    console.log();
    allOptions.forEach((opt, idx) => {
      const isLast = idx === allOptions.length - 1;
      const branch = isLast ? "└─" : "├─";
      const branchColor = idx === 0 ? colorCyan(branch) : colorDim(branch);
      const label = idx === 0 ? colorCyan(opt.label) : opt.label === "Back" ? colorDim(opt.label) : opt.label;
      console.log(`${branchColor} ${label}`);
    });

    // Set up key handler
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      /* ignore */
    }

    const keyHandler = (key: Buffer) => {
      const str = key.toString();

      if (str === "\u0003") {
        // Ctrl+C
        process.stdin.removeListener("data", keyHandler);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      } else if (str === "\u001b[A") {
        // Up arrow
        selected = (selected - 1 + allOptions.length) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[B") {
        // Down arrow
        selected = (selected + 1) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[D") {
        // Left arrow - same as selecting "Back"
        process.stdin.removeListener("data", keyHandler);
        resolve(null);
      } else if (str === "\r") {
        // Enter
        process.stdin.removeListener("data", keyHandler);
        const selectedOption = allOptions[selected];
        const isBack = selectedOption.label === "Back" || selectedOption.value === null;

        if (isBack) {
          resolve(null);
        } else {
          resolve({ index: selected, value: selectedOption.value });
        }
      }
    };

    process.stdin.on("data", keyHandler);
  });
}

