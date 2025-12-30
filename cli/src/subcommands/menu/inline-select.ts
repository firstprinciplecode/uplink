import { colorCyan, colorDim, colorWhite } from "./colors";

export type SelectOption = { label: string; value: string | number | null };

// Inline arrow-key selector (returns selected index, or null for "Back")
export async function inlineSelect(
  title: string,
  options: SelectOption[],
  includeBack: boolean = true
): Promise<{ index: number; value: string | number | null } | null> {
  return new Promise((resolve) => {
    const allOptions = includeBack ? [...options, { label: "Back", value: null }] : options;
    let selected = 0;

    const renderSelector = () => {
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
          label = opt.label === "Back" ? colorDim(opt.label) : colorCyan(opt.label);
        } else {
          branchColor = colorWhite(branch);
          label = opt.label === "Back" ? colorDim(opt.label) : colorWhite(opt.label);
        }

        console.log(`${branchColor} ${label}`);
      });
    };

    console.log();
    console.log(colorDim(title));
    console.log();
    allOptions.forEach((opt, idx) => {
      const isLast = idx === allOptions.length - 1;
      const branch = isLast ? "└─" : "├─";
      const branchColor = idx === 0 ? colorCyan(branch) : colorWhite(branch);
      const label = idx === 0 ? colorCyan(opt.label) : opt.label === "Back" ? colorDim(opt.label) : colorWhite(opt.label);
      console.log(`${branchColor} ${label}`);
    });

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      /* ignore */
    }

    const keyHandler = (key: Buffer) => {
      const str = key.toString();

      if (str === "\u0003") {
        process.stdin.removeListener("data", keyHandler);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      } else if (str === "\u001b[A") {
        selected = (selected - 1 + allOptions.length) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[B") {
        selected = (selected + 1) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[D") {
        process.stdin.removeListener("data", keyHandler);
        resolve(null);
      } else if (str === "\r") {
        process.stdin.removeListener("data", keyHandler);
        const selectedOption = allOptions[selected];
        if (selectedOption.label === "Back" || selectedOption.value === null) {
          resolve(null);
        } else {
          resolve({ index: selected, value: selectedOption.value });
        }
      }
    };

    process.stdin.on("data", keyHandler);
  });
}
