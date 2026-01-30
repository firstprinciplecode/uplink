import fetch, { AbortError } from "node-fetch";
import { getResolvedApiBase, getResolvedApiToken } from "./utils/api-base";

// Configuration
const REQUEST_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;
const MAX_RETRIES_RATE_LIMIT = 5; // More retries for rate limits
const INITIAL_RETRY_DELAY = 1000; // 1 second
const INITIAL_RATE_LIMIT_DELAY = 5000; // 5 seconds for rate limit errors

// Check if error is retryable (network issues, 5xx errors)
function isRetryable(error: unknown, statusCode?: number): boolean {
  // Network errors are retryable
  if (error instanceof AbortError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("econnrefused") || msg.includes("enotfound") || 
        msg.includes("etimedout") || msg.includes("econnreset") ||
        msg.includes("socket hang up")) {
      return true;
    }
  }
  // 5xx server errors are retryable
  if (statusCode && statusCode >= 500 && statusCode < 600) return true;
  // 429 Too Many Requests is retryable
  if (statusCode === 429) return true;
  return false;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const apiBase = getResolvedApiBase();
  const apiToken = getResolvedApiToken(apiBase);
  if (!apiToken) {
    throw new Error("Missing AGENTCLOUD_TOKEN");
  }

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const json = await response.json().catch(() => ({}));
      
      if (!response.ok) {
        // Special handling for rate limit errors (429)
        if (response.status === 429) {
          const maxRetries = MAX_RETRIES_RATE_LIMIT;
          if (attempt < maxRetries - 1) {
            // Check for Retry-After header
            const retryAfter = response.headers.get('Retry-After');
            let delay: number;
            if (retryAfter) {
              const retryAfterSeconds = parseInt(retryAfter, 10);
              delay = isNaN(retryAfterSeconds) ? INITIAL_RATE_LIMIT_DELAY * Math.pow(2, attempt) : retryAfterSeconds * 1000;
            } else {
              // Exponential backoff starting at 5 seconds for rate limits
              delay = INITIAL_RATE_LIMIT_DELAY * Math.pow(2, attempt);
            }
            await sleep(delay);
            continue;
          }
        }
        
        // Check if this error is retryable
        if (isRetryable(null, response.status) && attempt < MAX_RETRIES - 1) {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new Error(JSON.stringify(json, null, 2));
      }

      return json;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));
      // Check if we should retry
      if (isRetryable(error) && attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      
      // Not retryable or out of retries
      if (error instanceof AbortError) {
        throw new Error(`Request timeout after ${REQUEST_TIMEOUT}ms`);
      }
      throw lastError;
    }
  }
  
  throw lastError || new Error("Request failed after retries");
}
