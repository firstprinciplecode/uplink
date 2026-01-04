import type { MenuChoice } from "../types";

type Deps = {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>;
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
  truncate: (text: string, max: number) => string;
};

export function buildManageTokensMenu(deps: Deps): MenuChoice {
  const { apiRequest, promptLine, restoreRawMode, truncate } = deps;

  return {
    label: "Manage Tokens",
    subMenu: [
      {
        label: "List Tokens",
        action: async () => {
          const result = await apiRequest("GET", "/v1/admin/tokens");
          const tokens = result.tokens || [];
          if (!tokens.length) return "No tokens found.";
          const lines = tokens.map(
            (t: any) =>
              `${truncate(t.id, 12)}  ${truncate(t.token_prefix || t.tokenPrefix || "-", 10).padEnd(12)}  ${truncate(
                t.role ?? "-",
                6
              ).padEnd(8)}  ${truncate(t.label ?? "-", 20).padEnd(22)}  ${truncate(
                t.created_by_user_id ?? t.createdByUserId ?? "-",
                12
              ).padEnd(14)}  ${truncate(t.created_at ?? t.createdAt ?? "", 19)}`
          );
          return [
            "ID           Prefix        Role     Label                   Created By      Created",
            "-".repeat(105),
            ...lines,
          ].join("\n");
        },
      },
      {
        label: "Create Token",
        action: async () => {
          const roleAnswer = await promptLine("Role (admin/user, default user): ");
          const role = roleAnswer.trim().toLowerCase() === "admin" ? "admin" : "user";
          const labelAnswer = await promptLine("Label (optional): ");
          const label = labelAnswer.trim() || undefined;
          const expiresAnswer = await promptLine("Expires in days (optional): ");
          const expiresDays = expiresAnswer.trim() ? Number(expiresAnswer) : undefined;

          restoreRawMode();

          const body: Record<string, unknown> = { role };
          if (label) body.label = label;
          if (expiresDays && expiresDays > 0) body.expiresInDays = expiresDays;

          const result = await apiRequest("POST", "/v1/admin/tokens", body);
          const rawToken = result.token || "(no token returned)";
          return [
            "✓ Token created",
            "",
            `→ Token     ${rawToken}`,
            `→ ID        ${result.id}`,
            `→ Role      ${result.role}`,
            `→ Label     ${result.label || "-"}`,
            result.expiresAt ? `→ Expires   ${result.expiresAt}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
      {
        label: "Revoke Token",
        action: async () => {
          const tokenIdAnswer = await promptLine("Token ID to revoke: ");
          const tokenId = tokenIdAnswer.trim();
          restoreRawMode();
          if (!tokenId) return "No token ID provided.";

          // Backend supports revoke via POST /v1/admin/tokens/revoke
          await apiRequest("POST", "/v1/admin/tokens/revoke", { id: tokenId });
          return `✓ Token ${tokenId} revoked`;
        },
      },
    ],
  };
}

