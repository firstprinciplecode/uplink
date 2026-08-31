export const PROVIDER_IDS = ["godaddy", "cloudflare", "hostinger", "namecheap", "dreamhost", "cpanel"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type RegistrarCredentials = {
  token?: string;
  apiUser?: string;
  apiKey?: string;
  accountId?: string;
  /** Server hostname for panel-based providers (e.g. cPanel on port 2083). */
  host?: string;
  /** Additional API keys for providers with multiple accounts (e.g. DreamHost). */
  extraTokens?: string[];
};

export type InventoryDomain = {
  domain: string;
  provider: ProviderId;
  status: "owned";
  expiresAt?: string;
};

export type DomainQuote = {
  domain: string;
  provider: ProviderId;
  status: "owned" | "available" | "taken" | "not_for_sale" | "unknown";
  buyable?: boolean;
  priceUsd?: number;
  premium?: boolean;
  error?: string;
};

export type RegistrarAdapter = {
  id: ProviderId;
  label: string;
  /** What an agent must pass to connect. */
  connectHelp: string;
  verify(creds: RegistrarCredentials): Promise<RegistrarCredentials>;
  listDomains(creds: RegistrarCredentials): Promise<InventoryDomain[]>;
  check(creds: RegistrarCredentials, domain: string): Promise<DomainQuote>;
};
