import { Box, Text } from "ink";

const WORDMARK = [
  " _   _ ___ _    ___ _  _ _  __",
  "| | | | _ \\ |  |_ _| \\| | |/ /",
  "| |_| |  _/ |__ | || .` | ' < ",
  " \\___/|_| |____|___|_|\\_|_|\\_\\",
];

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
