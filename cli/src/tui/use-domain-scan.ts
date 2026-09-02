import { useCallback, useEffect, useRef, useState } from "react";
import { checkDomainAvailability } from "../utils/domain-availability";
import { getAdapter } from "../registrars";
import { readRegistrarStore } from "../registrars/store";

const BATCH_SIZE = 16;

export type ScanHit = {
  domain: string;
  priceUsd?: number;
  premium?: boolean;
};

export type ScanState = {
  found: ScanHit[];
  checked: number;
  total: number;
  skipped: number;
  running: boolean;
  done: boolean;
  error?: string;
};

const IDLE: ScanState = {
  found: [],
  checked: 0,
  total: 0,
  skipped: 0,
  running: false,
  done: false,
};

export function useDomainScan() {
  const [state, setState] = useState<ScanState>(IDLE);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    setState((prev) => ({ ...prev, running: false }));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    setState(IDLE);
  }, []);

  const start = useCallback((tlds: string[], loadCandidates: () => Promise<string[]>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    setState({ ...IDLE, running: true });

    void (async () => {
      let domains: string[];
      try {
        const candidates = await loadCandidates();
        domains = candidates.flatMap((name) => tlds.map((tld) => `${name}.${tld}`));
      } catch (error) {
        if (!signal.aborted) {
          setState({
            ...IDLE,
            done: true,
            error: error instanceof Error ? error.message : "failed to load candidates",
          });
        }
        return;
      }
      if (signal.aborted) return;
      setState((prev) => ({ ...prev, total: domains.length }));

      for (let i = 0; i < domains.length && !signal.aborted; i += BATCH_SIZE) {
        const batch = domains.slice(i, i + BATCH_SIZE);
        const answers = await Promise.all(
          batch.map(async (domain) => {
            if (signal.aborted) return undefined;
            try {
              const result = await checkDomainAvailability(domain);
              if (result.status === "available") return true;
              if (result.status === "taken") return false;
              return undefined;
            } catch {
              return undefined;
            }
          })
        );
        if (signal.aborted) return;

        const maybeFree = batch.filter((_, j) => answers[j] === true);
        const skipped = answers.filter((a) => a === undefined).length;
        const hits = await toScanHits(maybeFree, signal);
        if (signal.aborted) return;
        setState((prev) => ({
          ...prev,
          checked: prev.checked + batch.length,
          skipped: prev.skipped + skipped,
          found: hits.length > 0 ? [...prev.found, ...hits] : prev.found,
        }));
      }

      if (!signal.aborted) setState((prev) => ({ ...prev, running: false, done: true }));
    })();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { state, start, stop, reset };
}

async function toScanHits(domains: string[], signal: AbortSignal): Promise<ScanHit[]> {
  if (domains.length === 0) return [];
  const creds = readRegistrarStore().namecheap;
  if (!creds) return domains.map((domain) => ({ domain }));
  const quotes = await Promise.all(
    domains.map(async (domain) => {
      if (signal.aborted) return null;
      try {
        return await getAdapter("namecheap").check(creds, domain);
      } catch {
        return { domain, buyable: true as const, priceUsd: undefined, premium: undefined };
      }
    })
  );
  if (signal.aborted) return [];
  return quotes.flatMap((quote) => {
    if (!quote || quote.buyable === false) return [];
    return [{ domain: quote.domain, priceUsd: quote.priceUsd, premium: quote.premium }];
  });
}
