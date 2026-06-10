/** Minimal shape of Cloudflare's native Workers rate-limit binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Enforces a per-IP limit. Returns a 429 Response when over the limit, or null to
 * proceed. Skips limiting when there's no client IP (local `wrangler dev`) or no
 * binding, so local E2E isn't blocked.
 */
export async function enforce(
  request: Request,
  limiter: RateLimiter | undefined,
): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !limiter) return null;
  const { success } = await limiter.limit({ key: ip });
  if (success) return null;
  return Response.json(
    { error: "rate limit exceeded — slow down" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}
