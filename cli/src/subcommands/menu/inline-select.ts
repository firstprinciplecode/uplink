import { colorAccent, colorBold, colorDim, colorSoftGray } from "./colors";

export type SelectOption = { label: string; value: string | number | null };

// Inline arrow-key selector (returns selected index, or null for "Back")
// Clean, minimal styling inspired by Claude Code
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
      console.log("  " + colorSoftGray(title));
      console.log();

      allOptions.forEach((opt, idx) => {
        const isSelected = idx === selected;
        const pointer = isSelected ? colorAccent("›") : " ";
        
        let label: string;
        if (opt.label === "Back") {
          label = colorSoftGray(opt.label);
        } else if (isSelected) {
          label = colorBold(opt.label);
        } else {
          label = opt.label;
        }

        console.log(`  ${pointer} ${label}`);
      });
    };

    console.log();
    console.log("  " + colorSoftGray(title));
    console.log();
    allOptions.forEach((opt, idx) => {
      const isSelected = idx === 0;
      const pointer = isSelected ? colorAccent("›") : " ";
      const label = opt.label === "Back" ? colorSoftGray(opt.label) : (isSelected ? colorBold(opt.label) : opt.label);
      console.log(`  ${pointer} ${label}`);
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
