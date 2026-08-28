import { launchDomainking, resolveDomainkingEntry } from "../../../utils/launchDomainking";
import { runCliCapture } from "./hosting";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
};

/**
 * Shared "find a domain" action: the Domainking search TUI when it is
 * available, otherwise an inline prompt against `uplink domains check`
 * (which works without a registrar via public DNS/RDAP).
 */
export function buildFindDomainAction(deps: Deps): () => Promise<string> {
  return async () => {
    if (resolveDomainkingEntry()) {
      deps.restoreRawMode();
      return launchDomainking();
    }

    const domain = (await deps.promptLine("Domain to check (e.g. example.com, or back): "))
      .trim()
      .toLowerCase();
    deps.restoreRawMode();
    if (!domain || domain === "back") return "";
    if (!domain.includes(".")) return "Pass a full domain like example.com";

    try {
      return runCliCapture(["domains", "check", domain]) || `${domain}: no result.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}
