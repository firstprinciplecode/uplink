import fetch from "node-fetch";

const NEON_API_KEY = process.env.NEON_API_KEY;
const NEON_API_BASE = "https://console.neon.tech/api/v2";

if (!NEON_API_KEY) {
  console.warn("NEON_API_KEY is not set; Neon provider calls will fail.");
}

interface CreateNeonDbArgs {
  name: string;
  region: string;
  plan: string;
}

interface CreateNeonDbResult {
  providerDatabaseId: string;
  version: string;
  host: string;
  port: number;
  database: string;
  user: string;
  encryptedPassword: string;
  directConnectionString: string;
  pooledConnectionString?: string;
}

// Placeholder encryption – replace with real encryption-at-rest
function encryptPassword(plain: string): string {
  return plain;
}

export async function createNeonDatabase(
  args: CreateNeonDbArgs
): Promise<CreateNeonDbResult> {
  if (!NEON_API_KEY) {
    throw new Error("Missing NEON_API_KEY");
  }

  const projectId = process.env.NEON_PROJECT_ID;
  if (!projectId) {
    throw new Error("Missing NEON_PROJECT_ID");
  }

  // Use the primary/default branch instead of creating new branches
  // List branches to find the primary one
  const branchesRes = await fetch(
    `${NEON_API_BASE}/projects/${projectId}/branches`,
    {
      headers: {
        Authorization: `Bearer ${NEON_API_KEY}`,
      },
    }
  );

  const branchesJson: any = await branchesRes.json();
  if (!branchesRes.ok) {
    throw new Error(`Neon error getting branches: ${JSON.stringify(branchesJson)}`);
  }

  const branches = branchesJson.branches || [];
  const primaryBranch = branches.find((b: any) => b.primary) || branches.find((b: any) => b.default) || branches[0];
  if (!primaryBranch) {
    throw new Error("Neon project has no branches");
  }

  const defaultBranchId = primaryBranch.id;

  // Get endpoints for the default branch
  const endpointsRes = await fetch(
    `${NEON_API_BASE}/projects/${projectId}/branches/${defaultBranchId}/endpoints`,
    {
      headers: {
        Authorization: `Bearer ${NEON_API_KEY}`,
      },
    }
  );

  const endpointsJson: any = await endpointsRes.json();
  const endpoint = endpointsJson.endpoints?.[0];
  if (!endpoint) {
    throw new Error("Neon default branch has no endpoints");
  }

  // Create a role/user first (needed as owner for database)
  // Retry logic for Neon's operation queuing
  const roleName = `user_${args.name.replace(/[^a-z0-9]/g, "_")}`;
  let roleJson: any = null;
  let roleRes: any = null;
  
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
    }
    
    roleRes = await fetch(
      `${NEON_API_BASE}/projects/${projectId}/branches/${defaultBranchId}/roles`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NEON_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: {
            name: roleName,
          },
        }),
      }
    );

    roleJson = await roleRes.json();
    if (roleRes.ok || roleJson.message?.includes("already exists")) {
      break;
    }
    if (!roleJson.message?.includes("conflicting operations")) {
      throw new Error(`Neon error creating role: ${JSON.stringify(roleJson)}`);
    }
  }

  if (!roleRes.ok && !roleJson.message?.includes("already exists")) {
    throw new Error(`Neon error creating role after retries: ${JSON.stringify(roleJson)}`);
  }

  // Create a database on the default branch with the role as owner
  const dbName = `db_${args.name.replace(/[^a-z0-9]/g, "_")}`;
  let dbJson: any = null;
  let dbRes: any = null;
  
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
    }
    
    dbRes = await fetch(
      `${NEON_API_BASE}/projects/${projectId}/branches/${defaultBranchId}/databases`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NEON_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          database: {
            name: dbName,
            owner_name: roleName,
          },
        }),
      }
    );

    dbJson = await dbRes.json();
    if (dbRes.ok || dbJson.message?.includes("already exists")) {
      break;
    }
    if (!dbJson.message?.includes("conflicting operations")) {
      throw new Error(`Neon error creating database: ${JSON.stringify(dbJson)}`);
    }
  }

  if (!dbRes.ok && !dbJson.message?.includes("already exists")) {
    throw new Error(`Neon error creating database after retries: ${JSON.stringify(dbJson)}`);
  }

  const password = roleJson.role?.password || roleJson.password || "no-password-set";
  const encryptedPassword = encryptPassword(password);

  const host = endpoint.host;
  const port = endpoint.port ?? 5432;
  const database = dbName;
  const user = roleName;

  const direct = `postgres://${encodeURIComponent(
    user
  )}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;

  // Pooled connection string (if available)
  const pooledHost = endpoint.pooler_host || host.replace(/\.neon\.tech$/, "-pooler.neon.tech");
  const pooled = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${pooledHost}:${port}/${database}?sslmode=require`;

  return {
    providerDatabaseId: `${defaultBranchId}:${dbName}:${roleName}`, // Composite ID
    version: "16",
    host,
    port,
    database,
    user,
    encryptedPassword,
    directConnectionString: direct,
    pooledConnectionString: pooled,
  };
}

export async function deleteNeonDatabase(args: {
  providerDatabaseId: string;
}): Promise<void> {
  if (!NEON_API_KEY) {
    throw new Error("Missing NEON_API_KEY");
  }
  const projectId = process.env.NEON_PROJECT_ID;
  if (!projectId) {
    throw new Error("Missing NEON_PROJECT_ID");
  }

  const response = await fetch(
    `${NEON_API_BASE}/projects/${projectId}/branches/${args.providerDatabaseId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${NEON_API_KEY}`,
      },
    }
  );

  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(`Neon delete error: ${JSON.stringify(json)}`);
  }
}

