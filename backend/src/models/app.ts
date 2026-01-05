export type AppDeploymentStatus = "queued" | "deploying" | "running" | "failed";
export type AppReleaseUploadStatus = "pending" | "uploaded" | "failed";
export type AppReleaseBuildStatus = "queued" | "building" | "ready" | "failed";

export interface AppRecord {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppReleaseRecord {
  id: string;
  appId: string;
  sha256: string;
  sizeBytes: number;
  artifactKey: string;
  uploadStatus: AppReleaseUploadStatus;
  buildStatus: AppReleaseBuildStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppDeploymentRecord {
  id: string;
  appId: string;
  releaseId: string;
  status: AppDeploymentStatus;
  runnerTarget: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppResponse {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function toAppResponse(record: AppRecord, hostDomain: string): AppResponse {
  const scheme = (process.env.HOST_URL_SCHEME || "https").toLowerCase();
  return {
    id: record.id,
    name: record.name,
    url: `${scheme}://${record.id}.${hostDomain}`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

