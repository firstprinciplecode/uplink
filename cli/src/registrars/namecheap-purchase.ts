import { httpError } from "./http";
import type { RegistrarCredentials } from "./types";
import type { RegistrantContact } from "../utils/registrant-contact";

const API_URL = "https://api.namecheap.com/xml.response";

let clientIpPromise: Promise<string> | undefined;

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
  extra: Record<string, string>,
  method: "GET" | "POST" = "GET"
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
  const res =
    method === "POST"
      ? await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params,
        })
      : await fetch(`${API_URL}?${params}`);
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

export type NamecheapBalance = {
  currency: string;
  available: number;
  account: number;
};

export async function getNamecheapBalance(creds: RegistrarCredentials): Promise<NamecheapBalance> {
  const xml = await namecheapCall(creds, "namecheap.users.getBalances", {});
  const tag = xml.match(/<UserGetBalancesResult\b([^>]*)\/?>/i)?.[1];
  if (!tag) throw new Error("Namecheap balance response missing");
  return {
    currency: attr(tag, "Currency") || "USD",
    available: Number(attr(tag, "AvailableBalance") || "0"),
    account: Number(attr(tag, "AccountBalance") || "0"),
  };
}

export type AddFundsRequest = {
  tokenId: string;
  redirectUrl: string;
  returnUrl: string;
  amount: number;
};

/**
 * Creates a Namecheap credit-card add-funds session and returns the payment URL.
 * Domain purchase charges account balance — fund first if AvailableBalance is low.
 */
export async function createNamecheapAddFundsRequest(
  creds: RegistrarCredentials,
  amount: number,
  returnUrl = "https://www.namecheap.com/"
): Promise<AddFundsRequest> {
  if (!Number.isFinite(amount) || amount < 5) {
    throw new Error("Namecheap add-funds amount must be at least $5");
  }
  const xml = await namecheapCall(creds, "namecheap.users.createaddfundsrequest", {
    Username: creds.apiUser || "",
    PaymentType: "creditcard",
    Amount: amount.toFixed(2),
    ReturnUrl: returnUrl,
  });
  const tag =
    xml.match(/<Createaddfundsrequestresult\b([^>]*)\/?>/i)?.[1] ||
    xml.match(/<CreateAddFundsRequestResult\b([^>]*)\/?>/i)?.[1];
  if (!tag) throw new Error("Namecheap add-funds response missing redirect URL");
  const redirectUrl = attr(tag, "RedirectURL") || attr(tag, "ReturnURL");
  const tokenId = attr(tag, "TokenID") || "";
  if (!redirectUrl) throw new Error("Namecheap add-funds response missing RedirectURL");
  return {
    tokenId,
    redirectUrl,
    returnUrl: attr(tag, "ReturnURL") || returnUrl,
    amount,
  };
}

function contactFields(prefix: string, contact: RegistrantContact): Record<string, string> {
  const fields: Record<string, string> = {
    [`${prefix}FirstName`]: contact.firstName,
    [`${prefix}LastName`]: contact.lastName,
    [`${prefix}Address1`]: contact.address1,
    [`${prefix}City`]: contact.city,
    [`${prefix}StateProvince`]: contact.stateProvince,
    [`${prefix}PostalCode`]: contact.postalCode,
    [`${prefix}Country`]: contact.country,
    [`${prefix}Phone`]: contact.phone,
    [`${prefix}EmailAddress`]: contact.email,
  };
  if (contact.organizationName) fields[`${prefix}OrganizationName`] = contact.organizationName;
  return fields;
}

export type RegisterDomainResult = {
  domain: string;
  registered: boolean;
  chargedAmount?: number;
  orderId?: string;
  domainId?: string;
  transactionId?: string;
};

export async function registerNamecheapDomain(
  creds: RegistrarCredentials,
  opts: {
    domain: string;
    years?: number;
    contact: RegistrantContact;
    premium?: boolean;
    premiumPrice?: number;
  }
): Promise<RegisterDomainResult> {
  const years = opts.years ?? 1;
  const extra: Record<string, string> = {
    DomainName: opts.domain,
    Years: String(years),
    AddFreeWhoisguard: "yes",
    WGEnabled: "yes",
    ...contactFields("Registrant", opts.contact),
    ...contactFields("Tech", opts.contact),
    ...contactFields("Admin", opts.contact),
    ...contactFields("AuxBilling", opts.contact),
  };
  if (opts.premium) {
    extra.IsPremiumDomain = "true";
    if (opts.premiumPrice != null) extra.PremiumPrice = opts.premiumPrice.toFixed(2);
  }
  const xml = await namecheapCall(creds, "namecheap.domains.create", extra, "POST");
  const tag = xml.match(/<DomainCreateResult\b([^>]*)\/?>/i)?.[1];
  if (!tag) throw new Error("Namecheap create response missing DomainCreateResult");
  const registered = attr(tag, "Registered")?.toLowerCase() === "true";
  return {
    domain: attr(tag, "Domain") || opts.domain,
    registered,
    chargedAmount: Number(attr(tag, "ChargedAmount") || "") || undefined,
    orderId: attr(tag, "OrderID"),
    domainId: attr(tag, "DomainID"),
    transactionId: attr(tag, "TransactionID"),
  };
}

/** Pull registrant contact from an already-owned domain (seeds ~/.uplink/registrant.json). */
export async function fetchNamecheapDomainContact(
  creds: RegistrarCredentials,
  domain: string
): Promise<RegistrantContact | null> {
  const xml = await namecheapCall(creds, "namecheap.domains.getContacts", { DomainName: domain });
  const block = xml.match(/<Registrant>([\s\S]*?)<\/Registrant>/i)?.[1];
  if (!block) return null;
  const get = (name: string) =>
    new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(block)?.[1]?.trim() || "";
  const contact: RegistrantContact = {
    firstName: get("FirstName"),
    lastName: get("LastName"),
    address1: get("Address1"),
    city: get("City"),
    stateProvince: get("StateProvince"),
    postalCode: get("PostalCode"),
    country: get("Country"),
    phone: get("Phone"),
    email: get("EmailAddress"),
    organizationName: get("OrganizationName") || undefined,
  };
  if (!contact.firstName || !contact.lastName || !contact.email) return null;
  return contact;
}

/** Browser cart deep-link (manual checkout — does not use API balance). */
export function namecheapCartUrl(domain: string, years = 1): string {
  const params = new URLSearchParams({
    producttype: "domains",
    action: "purchase",
    domainlist: domain,
    billingcycle: String(years),
  });
  return `https://www.namecheap.com/cart/addtocart.aspx?${params}`;
}
