import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "./logger";

type R2Config = {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

let cachedClient: S3Client | null = null;
let cachedConfig: R2Config | null = null;

function resolveR2Config(): R2Config | null {
  const bucket =
    process.env.CLOUDFLARE_R2_BUCKET_NAME ||
    process.env.R2_BUCKET_NAME ||
    "";
  const endpoint =
    process.env.CLOUDFLARE_R2_S3_ENDPOINT_US ||
    process.env.CLOUDFLARE_R2_S3_ENDPOINT ||
    "";
  const accessKeyId =
    process.env.CLOUDFLARE_R2_S3_ACCESS_KEY_ID ||
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ||
    "";
  const secretAccessKey =
    process.env.CLOUDFLARE_R2_S3_SECRET_ACCESS_KEY ||
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ||
    "";
  const region = process.env.CLOUDFLARE_R2_REGION || "auto";

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, accessKeyId, secretAccessKey, region };
}

export function isR2Enabled(): boolean {
  return !!resolveR2Config();
}

export function getR2Client(): { client: S3Client; config: R2Config } | null {
  const config = resolveR2Config();
  if (!config) return null;
  if (!cachedClient || !cachedConfig || cachedConfig.bucket !== config.bucket) {
    cachedConfig = config;
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    logger.info({
      event: "r2.client.ready",
      bucket: config.bucket,
      endpoint: config.endpoint,
    });
  }
  return { client: cachedClient, config };
}

export async function signPutArtifactUrl(
  artifactKey: string,
  expiresSeconds = 15 * 60
): Promise<{ url: string; headers: Record<string, string> }> {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  const { client, config } = r2;
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: artifactKey,
    ContentType: "application/octet-stream",
  });
  const url = await getSignedUrl(client, command, { expiresIn: expiresSeconds });
  return { url, headers: { "Content-Type": "application/octet-stream" } };
}

export async function signGetArtifactUrl(
  artifactKey: string,
  expiresSeconds = 15 * 60
): Promise<string> {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  const { client, config } = r2;
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: artifactKey,
  });
  return getSignedUrl(client, command, { expiresIn: expiresSeconds });
}

export async function headArtifactObject(artifactKey: string) {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 not configured");
  const { client, config } = r2;
  const command = new HeadObjectCommand({
    Bucket: config.bucket,
    Key: artifactKey,
  });
  return client.send(command);
}
