import { apiRequest } from "../http";

export type Tunnel = {
  id: string;
  url?: string;
  ingressHttpUrl?: string;
  token?: string;
  alias?: string | null;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
};

export class TunnelsClient {
  async create(port: number, opts?: { project?: string; alias?: string }) {
    const tunnel = await apiRequest("POST", "/v1/tunnels", {
      port,
      project: opts?.project,
    }) as Tunnel;

    let aliasError: string | null = null;
    if (opts?.alias) {
      try {
        const aliasResult = await apiRequest("POST", `/v1/tunnels/${tunnel.id}/alias`, {
          alias: opts.alias,
        }) as Tunnel;
        tunnel.alias = aliasResult.alias ?? tunnel.alias;
      } catch (err: any) {
        aliasError = err?.message || String(err);
      }
    }

    return { tunnel, aliasError };
  }

  async list() {
    return apiRequest("GET", "/v1/tunnels") as Promise<{ tunnels: Tunnel[]; count: number }>;
  }

  async setAlias(id: string, alias: string) {
    return apiRequest("POST", `/v1/tunnels/${id}/alias`, { alias }) as Promise<Tunnel>;
  }

  async deleteAlias(id: string) {
    return apiRequest("DELETE", `/v1/tunnels/${id}/alias`) as Promise<Tunnel>;
  }

  async stats(id: string) {
    return apiRequest("GET", `/v1/tunnels/${id}/stats`);
  }

  async stop(id: string) {
    return apiRequest("DELETE", `/v1/tunnels/${id}`) as Promise<{ id: string; status: string }>;
  }
}
