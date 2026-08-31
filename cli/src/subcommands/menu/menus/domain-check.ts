import { join } from "path";
import { runEsmEntryAndWait } from "../../../utils/run-esm";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
};

/**
 * Built-in Find a domain TUI (DNS + RDAP).
 * Must not statically import Ink/DomainSearch — that file is ESM-only and
 * pulling it into the CJS menu graph crashes tsx on yoga-layout.
 */
export function buildFindDomainAction(deps: Deps): () => Promise<string> {
  return async () => {
    deps.restoreRawMode();
    runEsmEntryAndWait(join(__dirname, "../../../tui/domain-search.mts"));
    return "";
  };
}
