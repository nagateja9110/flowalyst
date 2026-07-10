/**
 * Per-IP token bucket. Each IP has a bucket of `capacity` tokens that refills at
 * `refillPerSec`; every request spends one. Empty bucket → 429 with Retry-After.
 *
 * Why a token bucket (not a fixed window): it allows a short burst up to
 * `capacity` while still bounding the sustained rate — no thundering edge at the
 * window boundary. In-memory + per-instance, which is fine for a single service;
 * a multi-instance deploy would move this state to Redis.
 *
 * Bucket shape: { tokens: number, last: number (ms timestamp of last refill) }
 */

export function rateLimit(opts) {
  const { capacity, refillPerSec } = opts;
  const buckets = new Map();

  // Evict idle buckets every 5 min so the map can't grow unbounded.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [ip, b] of buckets) if (b.last < cutoff) buckets.delete(ip);
  }, 5 * 60_000);
  sweep.unref?.();

  return (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: capacity, last: now };

    // Refill proportional to elapsed time, capped at capacity.
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
    b.last = now;

    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / refillPerSec);
      res.setHeader("Retry-After", String(retryAfter));
      buckets.set(ip, b);
      return res.status(429).json({
        error: `Rate limit exceeded on ${opts.name}. Retry in ~${retryAfter}s.`,
      });
    }

    b.tokens -= 1;
    buckets.set(ip, b);
    next();
  };
}
