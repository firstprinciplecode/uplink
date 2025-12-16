import { DatabaseResponse } from "../models/database";

export interface CreateDbRequestBody {
  name: string;
  project: string;
  provider?: "neon";
  region?: string;
  plan?: string;
}

export interface LinkServiceRequestBody {
  service: string;
  envVar: string;
}

export interface ListDbsResponse {
  items: Array<{
    id: string;
    name: string;
    project: string;
    provider: string;
    engine: string;
    region: string;
    status: string;
    ready: boolean;
    createdAt: string;
  }>;
}

export type GetDbResponse = DatabaseResponse;
export type CreateDbResponse = DatabaseResponse;

export interface DeleteDbResponse {
  id: string;
  status: "deleted";
}




