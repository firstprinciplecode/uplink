export type DatabaseStatus =
  | "provisioning"
  | "ready"
  | "error"
  | "deleting"
  | "deleted";

export interface DatabaseRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  name: string;
  provider: "neon"; // extend with more providers later
  providerDatabaseId: string;
  engine: "postgres";
  version: string;
  region: string;
  status: DatabaseStatus;
  host: string;
  port: number;
  database: string;
  user: string;
  encryptedPassword: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  connectionStrings: {
    direct: string;
    pooled?: string;
  };
}

export interface DatabaseResponse
  extends Omit<DatabaseRecord, "encryptedPassword" | "ownerUserId" | "providerDatabaseId"> {
  ready: boolean;
  connection: DatabaseConnectionInfo;
}

export function toDatabaseResponse(
  record: DatabaseRecord,
  directUrl: string,
  pooledUrl?: string
): DatabaseResponse {
  const connection: DatabaseConnectionInfo = {
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
    ssl: true,
    connectionStrings: {
      direct: directUrl,
      ...(pooledUrl ? { pooled: pooledUrl } : {}),
    },
  };

  return {
    id: record.id,
    name: record.name,
    projectId: record.projectId,
    provider: record.provider,
    engine: record.engine,
    version: record.version,
    region: record.region,
    status: record.status,
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
    ready: record.status === "ready",
    connection,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}





