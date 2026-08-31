import { cloudflareAdapter } from "./cloudflare";
import { cpanelAdapter } from "./cpanel";
import { dreamhostAdapter } from "./dreamhost";
import { godaddyAdapter } from "./godaddy";
import { hostingerAdapter } from "./hostinger";
import { namecheapAdapter } from "./namecheap";
import type { ProviderId, RegistrarAdapter } from "./types";

/** GoDaddy first, then the rest. Namecheap last because connect is the clumsiest. */
export const adapters: RegistrarAdapter[] = [
  godaddyAdapter,
  cloudflareAdapter,
  hostingerAdapter,
  namecheapAdapter,
  dreamhostAdapter,
  cpanelAdapter,
];

const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: ProviderId): RegistrarAdapter {
  const adapter = byId.get(id);
  if (!adapter) throw new Error(`Unknown provider: ${id}`);
  return adapter;
}

export { connectedProviders, readRegistrarStore, removeProvider, saveProvider } from "./store";
export { PROVIDER_IDS, isProviderId } from "./types";
export type {
  DomainQuote,
  InventoryDomain,
  ProviderId,
  RegistrarCredentials,
} from "./types";
