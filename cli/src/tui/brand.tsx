import { Box, Text } from "ink";

/** Same wordmark as uplink.spot (`pre.wordmark` in index.html). */
const WORDMARK = [
  " _   _ ___ _    ___ _  _ _  __",
  "| | | | _ \\ |  |_ _| \\| | |/ /",
  "| |_| |  _/ |__ | || .` | ' <",
  " \\___/|_| |____|___|_|\\__|_|\\_\\",
];

export const WORDMARK_TEXT = WORDMARK.join("\n");

export function Wordmark() {
  return (
    <Box flexDirection="column">
      {WORDMARK.map((line) => (
        <Text key={line} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}
