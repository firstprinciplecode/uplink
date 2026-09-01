import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";

export function Panel({
  children,
  accent,
  marginTop,
  title,
  paddingX = 1,
}: {
  children: ReactNode;
  accent?: boolean;
  marginTop?: number;
  title?: string;
  paddingX?: number;
}) {
  return (
    <Box
      flexDirection="column"
      width="100%"
      marginTop={marginTop}
      borderStyle="round"
      borderColor={accent ? "white" : undefined}
      borderDimColor={!accent}
      paddingX={paddingX}
    >
      {title ? <Text dimColor>{title}</Text> : null}
      {children}
    </Box>
  );
}

export function Fact({
  label,
  value,
  color,
  dim,
}: {
  label: string;
  value: string;
  color?: "green" | "red" | "yellow";
  dim?: boolean;
}) {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={color} dimColor={dim} wrap="truncate">
        {value}
      </Text>
    </Box>
  );
}

export function SearchField({
  value,
  placeholder,
  focused,
  label = "search",
}: {
  value: string;
  placeholder?: string;
  focused: boolean;
  label?: string;
}) {
  return (
    <Box
      width="100%"
      borderStyle="round"
      borderColor={focused ? "white" : undefined}
      borderDimColor={!focused}
      paddingX={1}
    >
      <Text dimColor>{label} › </Text>
      {value.length === 0 ? (
        <Text dimColor inverse={focused}>
          {placeholder ?? ""}
        </Text>
      ) : (
        <Text>
          {value}
          {focused ? <Text inverse> </Text> : null}
        </Text>
      )}
    </Box>
  );
}

export function KeyBar({ hint }: { hint: string }) {
  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderDimColor
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    >
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

export function MenuRow({
  index,
  label,
  active,
  suffix,
  danger,
  dim,
}: {
  index: number;
  label: string;
  active: boolean;
  suffix?: string;
  danger?: boolean;
  dim?: boolean;
}) {
  const { stdout } = useStdout();
  const inner = Math.max(16, (stdout?.columns ?? 80) - 8);
  const caret = active ? "▸" : " ";
  const line = ` ${caret} ${index} ${label}${suffix ?? ""}`;
  const padded = line.padEnd(inner).slice(0, inner);

  return (
    <Box width="100%">
      <Text inverse={active} color={danger && active ? "red" : undefined} dimColor={dim && !active}>
        {padded}
      </Text>
    </Box>
  );
}
