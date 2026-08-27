export async function readResponseBody(res: Response): Promise<string> {
  return res.text();
}

export async function parseJson<T>(res: Response): Promise<T> {
  const text = await readResponseBody(res);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${res.url} (${res.status})`);
  }
}

export function httpError(res: Response, body: string): Error {
  const trimmed = body.replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`HTTP ${res.status}${trimmed ? `: ${trimmed}` : ""}`);
}
