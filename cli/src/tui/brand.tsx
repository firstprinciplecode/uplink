import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Box, Text } from "ink";

/** Block FIGlet, 7 rows. ~62 cols so it still fits an 80-column pane. */
const ASCII_UPLINK = [
  "░██     ░██░█████████ ░██      ░██████░███    ░██░██     ░██",
  "░██     ░██░██     ░██░██        ░██  ░████   ░██░██    ░██",
  "░██     ░██░██     ░██░██        ░██  ░██░██  ░██░██   ░██",
  "░██     ░██░█████████ ░██        ░██  ░██ ░██ ░██░███████",
  "░██     ░██░██        ░██        ░██  ░██  ░██░██░██   ░██",
  " ░██   ░██ ░██        ░██        ░██  ░██   ░████░██    ░██",
  "  ░██████  ░██        ░████████░██████░██    ░███░██     ░██",
];

export function cliVersion(): string {
  const paths: string[] = [];
  try {
    paths.push(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"));
  } catch {
    // not ESM
  }
  if (typeof __dirname !== "undefined") {
    paths.push(join(__dirname, "../../../package.json"));
  }
  for (const pkgPath of paths) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.2.10";
}

export const WORDMARK_TEXT = ASCII_UPLINK.join("\n");

export function Wordmark({
  connected,
  tunnels,
  apps,
  crumb,
}: {
  connected?: boolean;
  tunnels?: number;
  apps?: number;
  crumb?: string;
}) {
  const live = connected === true;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="column" flexShrink={0} height={ASCII_UPLINK.length}>
        {ASCII_UPLINK.map((line, i) => (
          <Text key={i} color="white">
            {line}
          </Text>
        ))}
      </Box>
      <Box
        width="100%"
        marginTop={1}
        borderStyle="round"
        borderColor="white"
        paddingX={1}
        justifyContent="space-between"
      >
        {crumb ? <Text dimColor>› {crumb}</Text> : <Text dimColor>Agent based web management</Text>}
        <Box>
          {typeof tunnels === "number" ? (
            <Text>
              <Text dimColor>↗ </Text>
              {tunnels}
            </Text>
          ) : null}
          {typeof apps === "number" ? (
            <Text>
              <Text dimColor>  ▣ </Text>
              {apps}
            </Text>
          ) : null}
          <Text dimColor>
            {typeof tunnels === "number" || typeof apps === "number" ? "  " : ""}
            v{cliVersion()}
          </Text>
          {connected != null ? (
            <Text color={live ? "greenBright" : undefined} dimColor={!live}>
              {"  "}
              {live ? "●" : "○"}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
