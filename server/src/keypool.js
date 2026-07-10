// Load server/.env before the pools below read process.env at module init.
// Without this, importing keypool before config would yield empty pools.
import "./config.js";

/**
 * Round-robin API-key pool with per-key cooldown. On a 429 the key that hit
 * the limit is benched for a cooldown window and the next key takes over —
 * quota failover happens mid-conversation, invisible to the client.
 */
export class KeyPool {
  cooldownUntil = new Map();
  cursor = 0;

  constructor(keys, cooldownMs = 60_000) {
    this.keys = keys;
    this.cooldownMs = cooldownMs;
  }

  size() {
    return this.keys.length;
  }

  /** Next key that isn't cooling down, round-robin. Null if all are benched. */
  next() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(this.cursor + i) % this.keys.length];
      if ((this.cooldownUntil.get(key) ?? 0) <= now) {
        this.cursor = (this.cursor + i + 1) % this.keys.length;
        return key;
      }
    }
    return null;
  }

  cooldown(key) {
    this.cooldownUntil.set(key, Date.now() + this.cooldownMs);
  }

  /** Seconds until the soonest key becomes available again. */
  secondsUntilAvailable() {
    if (this.keys.length === 0) return Infinity;
    const soonest = Math.min(...this.keys.map((k) => this.cooldownUntil.get(k) ?? 0));
    return Math.max(0, Math.ceil((soonest - Date.now()) / 1000));
  }
}

function parseKeys(...envValues) {
  const keys = envValues
    .flatMap((v) => (v ?? "").split(","))
    .map((k) => k.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

/** All Gemini keys: GEMINI_API_KEYS (comma-separated) and/or GEMINI_API_KEY. */
export const geminiPool = new KeyPool(
  parseKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY),
);

/** All Groq keys: GROQ_API_KEYS (comma-separated) and/or GROQ_API_KEY. */
export const groqPool = new KeyPool(
  parseKeys(process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY),
);
