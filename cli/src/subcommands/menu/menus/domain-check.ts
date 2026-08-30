import { runDomainSearch } from "../../../tui/DomainSearch";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
};

/** Built-in Find a domain TUI (DNS + RDAP). Domainking remains a separate app. */
export function buildFindDomainAction(deps: Deps): () => Promise<string> {
  return async () => {
    deps.restoreRawMode();
    return runDomainSearch();
  };
}
