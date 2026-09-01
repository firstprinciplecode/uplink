import { httpError } from "./http";
import type { DomainQuote, InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

const API_URL = "https://api.namecheap.com/xml.response";

let clientIpPromise: Promise<string> | undefined;
const pricingCache = new Map<string, Promise<Map<string, number>>>();

async function clientIp(): Promise<string> {
  clientIpPromise ??= fetch("https://api.ipify.org")
    .then(async (res) => {
      if (!res.ok) throw new Error(`ip lookup failed (${res.status})`);
      return (await res.text()).trim();
    })
    .catch((error: unknown) => {
      clientIpPromise = undefined;
      throw error;
    });
  return clientIpPromise;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

async function namecheapCall(
  creds: RegistrarCredentials,
  command: string,
  extra: Record<string, string>
): Promise<string> {
  if (!creds.apiUser || !creds.apiKey) throw new Error("Namecheap API user and key are required");
  const params = new URLSearchParams({
    ApiUser: creds.apiUser,
    ApiKey: creds.apiKey,
    UserName: creds.apiUser,
    Command: command,
    ClientIp: await clientIp(),
    ...extra,
  });
  // POST keeps the API key out of the URL (query strings end up in proxy/server logs).
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const xml = await res.text();
  const status = /Status="([^"]+)"/.exec(xml)?.[1];
  if (status !== "OK") {
    const err = /<Error[^>]*>([^<]+)<\/Error>/.exec(xml)?.[1] || `Namecheap ${status || res.status}`;
    const ip = await clientIp().catch(() => "");
    if (/ip/i.test(err) && ip) {
      throw new Error(`${err}. Whitelist this machine's IP in Namecheap API access: ${ip}`);
    }
    throw new Error(err);
  }
  if (!res.ok) throw httpError(res, xml);
  return xml;
}

async function loadRegisterPrices(creds: RegistrarCredentials): Promise<Map<string, number>> {
  const xml = await namecheapCall(creds, "namecheap.users.getPricing", {
    ProductType: "DOMAIN",
    ActionName: "REGISTER",
  });
  const prices = new Map<string, number>();
  const categories = xml.matchAll(/<ProductCategory Name="register">([\s\S]*?)<\/ProductCategory>/gi);
  for (const category of categories) {
    const products = category[1].matchAll(/<Product Name="([^"]+)">([\s\S]*?)<\/Product>/gi);
    for (const match of products) {
      const tld = match[1].toLowerCase();
      const year1 =
        /<Price\b([^>]*Duration="1"[^>]*DurationType="YEAR"[^>]*)\/?>/i.exec(match[2]) ??
        /<Price\b([^>]*DurationType="YEAR"[^>]*Duration="1"[^>]*)\/?>/i.exec(match[2]);
      if (!year1) continue;
      const fields = year1[1];
      const your = Number(attr(fields, "YourPrice") ?? attr(fields, "Price"));
      if (!Number.isFinite(your)) continue;
      const extra = Number(attr(fields, "YourAdditonalCost") ?? attr(fields, "AdditionalCost") ?? "0");
      prices.set(tld, your + (Number.isFinite(extra) ? extra : 0));
    }
  }
  return prices;
}

function registerPrices(creds: RegistrarCredentials): Promise<Map<string, number>> {
  const key = creds.apiUser || "";
  let pending = pricingCache.get(key);
  if (!pending) {
    pending = loadRegisterPrices(creds).catch((error: unknown) => {
      pricingCache.delete(key);
      throw error;
    });
    pricingCache.set(key, pending);
  }
  return pending;
}

export const namecheapAdapter: RegistrarAdapter = {
  id: "namecheap",
  label: "Namecheap",
  connectHelp:
    "API key + username, and whitelist this machine's IP. --token-env NAMECHEAP_API_KEY --user-env NAMECHEAP_API_USER",
  async verify(creds) {
    await namecheapCall(creds, "namecheap.domains.getList", { PageSize: "20" });
    return creds;
  },
  async listDomains(creds) {
    const out: InventoryDomain[] = [];
    let page = 1;
    for (;;) {
      const xml = await namecheapCall(creds, "namecheap.domains.getList", {
        Page: String(page),
        PageSize: "100",
      });
      const tags = xml.matchAll(/<Domain\b([^>]*)\/?>/gi);
      let count = 0;
      for (const match of tags) {
        count += 1;
        const name = attr(match[1], "Name") || attr(match[1], "Domain");
        if (!name) continue;
        out.push({
          domain: name.toLowerCase(),
          provider: "namecheap",
          status: "owned",
          expiresAt: attr(match[1], "Expires") || attr(match[1], "ExpiredDate"),
        });
      }
      if (count < 100) break;
      page += 1;
      if (page > 50) break;
    }
    return out;
  },
  async check(creds, domain) {
    const xml = await namecheapCall(creds, "namecheap.domains.check", { DomainList: domain });
    const tag = xml.match(/<DomainCheckResult\b([^>]*)\/?>/i)?.[1];
    if (!tag) {
      return { domain, provider: "namecheap", status: "unknown", error: "no check result" };
    }
    const available = attr(tag, "Available")?.toLowerCase() === "true";
    const premium = attr(tag, "IsPremiumName")?.toLowerCase() === "true";
    if (!available) {
      return { domain, provider: "namecheap", status: "not_for_sale", buyable: false, premium };
    }
    if (premium) {
      const price =
        Number(attr(tag, "PremiumRegistrationPrice") || "0") + Number(attr(tag, "IcannFee") || "0");
      return {
        domain,
        provider: "namecheap",
        status: "available",
        buyable: true,
        premium: true,
        priceUsd: price > 0 ? price : undefined,
      };
    }
    const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
    const prices = await registerPrices(creds);
    return {
      domain,
      provider: "namecheap",
      status: "available",
      buyable: true,
      premium: false,
      priceUsd: prices.get(tld),
    };
  },
};
