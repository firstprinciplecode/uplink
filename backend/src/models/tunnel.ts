export type TunnelStatus = "active" | "inactive" | "deleted";

export interface TunnelRecord {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  token: string;
  targetPort: number;
  status: TunnelStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface TunnelResponse {
  id: string;
  token: string;
  url: string;
  targetPort: number;
  status: TunnelStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export function toTunnelResponse(
  record: TunnelRecord,
  domain: string,
  useHostRouting: boolean = true
): TunnelResponse {
  // NOTE: HTTPS for wildcard subdomains requires extra server-side config (DNS-01 / on-demand TLS).
  // Default to HTTP so returned URLs work immediately; can be overridden via env for deployments
  // that have HTTPS working.
  const scheme = (process.env.TUNNEL_URL_SCHEME || "http").toLowerCase();
  const url = useHostRouting
    ? `${scheme}://${record.token}.${domain}`
    : `http://127.0.0.1:7070/t/${record.token}`;

  return {
    id: record.id,
    token: record.token,
    url,
    targetPort: record.targetPort,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
}

