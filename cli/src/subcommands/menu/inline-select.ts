import { colorAccent, colorBold, colorDim, colorSoftGray } from "./colors";

export type SelectOption = { label: string; value: string | number | null };

function isBackKey(str: string): boolean {
  return str === "\u0003" || str === "\u001b" || str === "\u001b\u001b" || str === "\u001b[D";
}

export async function inlineSelect(
  title: string,
  options: SelectOption[],
  includeBack: boolean = true
): Promise<{ index: number; value: string | number | null } | null> {
  return new Promise((resolve) => {
    const allOptions = includeBack ? [...options, { label: "Back", value: null }] : options;
    let selected = 0;
    const hint = colorDim("  ↑↓ enter  ·  esc/← back");
    const frameLines = allOptions.length + 4;

    const paint = (initial: boolean) => {
      if (!initial) {
        process.stdout.write(`\x1b[${frameLines}A\x1b[0J`);
      }
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
      console.log(hint);
    };

    paint(true);

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      /* ignore */
    }

    const done = (value: { index: number; value: string | number | null } | null) => {
      process.stdin.removeListener("data", keyHandler);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const keyHandler = (key: Buffer) => {
      const str = key.toString();
      if (isBackKey(str)) {
        done(null);
        return;
      }
      if (str === "\u001b[A") {
        selected = (selected - 1 + allOptions.length) % allOptions.length;
        paint(false);
        return;
      }
      if (str === "\u001b[B") {
        selected = (selected + 1) % allOptions.length;
        paint(false);
        return;
      }
      if (str === "\r") {
        const selectedOption = allOptions[selected];
        if (selectedOption.label === "Back" || selectedOption.value === null) {
          done(null);
        } else {
          done({ index: selected, value: selectedOption.value });
        }
      }
    };

    process.stdin.on("data", keyHandler);
  });
}
