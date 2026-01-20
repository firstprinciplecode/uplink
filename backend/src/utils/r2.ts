export function isR2Enabled(): boolean {
  return false;
}

export async function signGetArtifactUrl(_key: string): Promise<string> {
  throw new Error("R2 is not enabled");
}
