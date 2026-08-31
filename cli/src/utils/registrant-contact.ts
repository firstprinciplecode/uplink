import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** WHOIS / registrant contact used for Namecheap domains.create */
export type RegistrantContact = {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  organizationName?: string;
};

function contactPath(): string {
  return join(homedir(), ".uplink", "registrant.json");
}

export function readRegistrantContact(): RegistrantContact | null {
  const path = contactPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistrantContact;
    if (!parsed?.firstName || !parsed?.lastName || !parsed?.email || !parsed?.phone) return null;
    if (!parsed.address1 || !parsed.city || !parsed.stateProvince || !parsed.postalCode || !parsed.country) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeRegistrantContact(contact: RegistrantContact): void {
  const dir = join(homedir(), ".uplink");
  mkdirSync(dir, { recursive: true });
  const path = contactPath();
  writeFileSync(path, JSON.stringify(contact, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function contactMissingFields(contact: Partial<RegistrantContact> | null | undefined): string[] {
  const required: (keyof RegistrantContact)[] = [
    "firstName",
    "lastName",
    "address1",
    "city",
    "stateProvince",
    "postalCode",
    "country",
    "phone",
    "email",
  ];
  if (!contact) return required;
  return required.filter((key) => !String(contact[key] || "").trim());
}
