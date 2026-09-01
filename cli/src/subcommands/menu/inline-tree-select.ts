import { colorBold, colorDim } from "./colors";

export type SelectOption = { label: string; value: string | number | null };

function isBackKey(str: string, bufEmpty = true): boolean {
  if (str === "\u0003") return true;
  if (str === "\u001b" || str === "\u001b\u001b") return true;
  if (str === "\u001b[D" && bufEmpty) return true;
  return false;
}

export async function inlineSelect(
  title: string,
  options: SelectOption[],
  includeBack: boolean = true
): Promise<{ index: number; value: string | number | null } | null> {
  return new Promise((resolve) => {
    const allOptions = includeBack ? [...options, { label: "Back", value: null }] : options;
    let selected = 0;
    const hint = colorDim("↑↓ enter  ·  esc/← back");
    const frameLines = allOptions.length + 4;

    const paint = (initial: boolean) => {
      if (!initial) {
        process.stdout.write(`\x1b[${frameLines}A\x1b[0J`);
      }
      console.log();
      console.log(colorDim(title));
      console.log();
      allOptions.forEach((opt, idx) => {
        const isLast = idx === allOptions.length - 1;
        const isSelected = idx === selected;
        const branch = isLast ? "└─" : "├─";
        const branchColor = isSelected ? colorBold(branch) : colorDim(branch);
        const label =
          opt.label === "Back"
            ? colorDim(opt.label)
            : isSelected
              ? colorBold(opt.label)
              : opt.label;
        console.log(`${branchColor} ${label}`);
      });
      console.log(hint);
    };

    paint(true);

    try {
      process.stdin.ref();
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
        const isBack = selectedOption.label === "Back" || selectedOption.value === null;
        done(isBack ? null : { index: selected, value: selectedOption.value });
      }
    };

    process.stdin.on("data", keyHandler);
  });
}
