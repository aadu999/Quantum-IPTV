import { eventBus } from '../core/event-bus';

const LS_KEY = 'quantum_source_health_v1';

/**
 * Half-life, in milliseconds, for every accumulated counter.
 *
 * The previous implementation summed fragment and stall counts forever. After an
 * hour of viewing a source had thousands of fragments recorded, so a fresh
 * outage moved its failure rate by a fraction of a percent and the score stayed
 * pinned near 100 while the picture was frozen. Decaying the counters means the
 * score reflects the last few minutes, which is the only window that matters for
 * "should I play this right now".
 */
const DECAY_HALF_LIFE_MS = 4 * 60 * 1000;

/** Below this score a source is skipped unless nothing better exists. */
const AVAILABILITY_THRESHOLD = 30;

export type SourceState = 'HEALTHY' | 'DEGRADED' | 'OPEN' | 'HALF_OPEN';

export interface SourceHealthVector {
  endpointKey: string;
  hostKey: string;
  startupSamples: number[];
  startupP50Ms: number;
  startupP95Ms: number;
  /** Decayed counters — fractional by design. */
  fragments: number;
  failedFragments: number;
  stalls: number;
  stallDurationMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastHealthyAt: number;
  lastFailureAt: number;
  lastDecayAt: number;
  /** When an OPEN source may next be probed. */
  openUntil: number;
  state: SourceState;
  score: number;
}

export class QuantumSourceHealthTracker {
  private sources: Map<string, SourceHealthVector> = new Map();
  private hostPenalties: Map<string, number> = new Map();
  private lastPersistAt = 0;

  constructor() {
    this.restore();
  }

  getEndpointKey(url: string): string {
    try {
      const parsed = new URL(url);
      // Exclude manifest/segment filenames (e.g. index.m3u8, master.m3u8) to key by channel path
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      const endpointSegments = pathSegments.filter(
        seg => !seg.endsWith('.m3u8') && !seg.endsWith('.ts') && !seg.endsWith('.mpd')
      );
      const channelPath = endpointSegments.length > 0 ? endpointSegments.join('/') : parsed.pathname;
      return `${parsed.hostname}/${channelPath}`;
    } catch {
      return url;
    }
  }

  getHostKey(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private getOrCreate(url: string): SourceHealthVector {
    const key = this.getEndpointKey(url);
    let vector = this.sources.get(key);
    if (!vector) {
      vector = {
        endpointKey: key,
        hostKey: this.getHostKey(url),
        startupSamples: [],
        startupP50Ms: 0,
        startupP95Ms: 0,
        fragments: 0,
        failedFragments: 0,
        stalls: 0,
        stallDurationMs: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastHealthyAt: Date.now(),
        lastFailureAt: 0,
        lastDecayAt: Date.now(),
        openUntil: 0,
        state: 'HEALTHY',
        score: 100
      };
      this.sources.set(key, vector);
    }
    return vector;
  }

  /** Ages every counter toward zero according to the elapsed half-lives. */
  private decay(vector: SourceHealthVector): void {
    const now = Date.now();
    const elapsed = now - vector.lastDecayAt;
    if (elapsed < 1000) return;

    const factor = Math.pow(0.5, elapsed / DECAY_HALF_LIFE_MS);
    vector.fragments *= factor;
    vector.failedFragments *= factor;
    vector.stalls *= factor;
    vector.stallDurationMs *= factor;
    vector.lastDecayAt = now;
  }

  calculateScore(url: string): number {
    const vector = this.getOrCreate(url);
    this.decay(vector);

    const now = Date.now();
    let score = 100;

    // 1. Consecutive hard failures dominate: a source that just refused to play
    // twice in a row is worse than one with a mediocre long-run average.
    if (vector.consecutiveFailures > 0) {
      score -= Math.min(80, vector.consecutiveFailures * 25);
    }

    // 2. Recent fragment failure rate. Requires a minimum sample so a single
    // failed request on a cold source does not read as 100% failure.
    if (vector.fragments >= 4) {
      const failureRate = vector.failedFragments / vector.fragments;
      score -= Math.min(40, Math.round(failureRate * 80));
    }

    // 3. Stall pressure, measured in seconds stalled rather than stall count —
    // ten brief hiccups are far less damaging than one 20-second freeze.
    if (vector.stallDurationMs > 0) {
      score -= Math.min(30, Math.round(vector.stallDurationMs / 1000) * 3);
    }

    // 4. Slow startup is a real quality signal even when nothing outright fails.
    if (vector.startupP50Ms > 6000) {
      score -= 10;
    }

    // 5. Collective degradation of the whole host.
    score -= this.hostPenalties.get(vector.hostKey) || 0;

    score = Math.max(0, Math.min(100, score));

    // 6. Breaker state. A source that fell below the threshold stays OPEN for a
    // cooldown, then gets exactly one probe (HALF_OPEN) before being condemned
    // again. Without this an unhealthy source is either retried constantly or
    // never retried at all.
    if (score < AVAILABILITY_THRESHOLD) {
      if (vector.state !== 'OPEN' && vector.state !== 'HALF_OPEN') {
        vector.state = 'OPEN';
        // Exponential cooldown with jitter, so a whole playlist pointing at one
        // dead CDN does not retry in lockstep.
        const backoff = Math.min(120000, 8000 * Math.pow(2, Math.min(4, vector.consecutiveFailures - 1)));
        vector.openUntil = now + backoff + Math.random() * 2000;
      } else if (vector.state === 'OPEN' && now >= vector.openUntil) {
        vector.state = 'HALF_OPEN';
        // Lift just above the bar so exactly one probe attempt is allowed.
        score = AVAILABILITY_THRESHOLD;
      } else if (vector.state === 'HALF_OPEN') {
        score = AVAILABILITY_THRESHOLD;
      }
    } else {
      vector.state = score >= 70 ? 'HEALTHY' : 'DEGRADED';
      vector.openUntil = 0;
    }

    vector.score = score;
    return score;
  }

  isAvailable(url: string): boolean {
    return this.calculateScore(url) >= AVAILABILITY_THRESHOLD;
  }

  getState(url: string): SourceState {
    this.calculateScore(url);
    return this.getOrCreate(url).state;
  }

  recordSuccess(url: string, startupTimeMs?: number): void {
    const vector = this.getOrCreate(url);
    this.decay(vector);

    vector.consecutiveFailures = 0;
    vector.consecutiveSuccesses += 1;
    vector.lastHealthyAt = Date.now();
    vector.state = 'HEALTHY';
    vector.openUntil = 0;

    if (startupTimeMs && startupTimeMs > 0) {
      vector.startupSamples.push(startupTimeMs);
      if (vector.startupSamples.length > 20) vector.startupSamples.shift();

      const sorted = [...vector.startupSamples].sort((a, b) => a - b);
      vector.startupP50Ms = sorted[Math.floor(sorted.length * 0.5)];
      vector.startupP95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    // Ease any host-level penalty on success
    const host = vector.hostKey;
    if (this.hostPenalties.has(host)) {
      const penalty = Math.max(0, (this.hostPenalties.get(host) || 0) - 5);
      if (penalty === 0) this.hostPenalties.delete(host);
      else this.hostPenalties.set(host, penalty);
    }

    this.calculateScore(url);
    this.persistThrottled();
    eventBus.emit('HEALTH_UPDATE', {
      endpointKey: vector.endpointKey,
      score: vector.score,
      status: 'HEALTHY'
    });
  }

  recordFailure(url: string, reason?: string): void {
    const vector = this.getOrCreate(url);
    this.decay(vector);

    vector.consecutiveFailures += 1;
    vector.consecutiveSuccesses = 0;
    vector.lastFailureAt = Date.now();

    // A probe that failed sends the source straight back to OPEN with a longer
    // cooldown, rather than letting it linger in HALF_OPEN and be retried again.
    if (vector.state === 'HALF_OPEN') {
      vector.state = 'OPEN';
      vector.openUntil = Date.now() + Math.min(120000, 15000 * vector.consecutiveFailures);
    }

    // Increment host penalty mildly only after multiple endpoint failures
    const host = vector.hostKey;
    if (vector.consecutiveFailures >= 3) {
      const currentPenalty = this.hostPenalties.get(host) || 0;
      this.hostPenalties.set(host, Math.min(40, currentPenalty + 10));
    }

    this.calculateScore(url);
    this.persistThrottled();
    eventBus.emit('HEALTH_UPDATE', {
      endpointKey: vector.endpointKey,
      score: vector.score,
      status: 'DEGRADED',
      reason
    });
  }

  recordFragment(url: string, success: boolean): void {
    const vector = this.getOrCreate(url);
    this.decay(vector);
    vector.fragments += 1;
    if (!success) {
      vector.failedFragments += 1;
    }
  }

  recordStall(url: string, durationMs: number): void {
    const vector = this.getOrCreate(url);
    this.decay(vector);
    vector.stalls += 1;
    vector.stallDurationMs += durationMs;
    this.calculateScore(url);
  }

  reset(url?: string): void {
    if (url) {
      this.sources.delete(this.getEndpointKey(url));
    } else {
      this.sources.clear();
      this.hostPenalties.clear();
    }
    this.persist();
  }

  getHealthSummary(): Record<string, { score: number; state: SourceState; stalls: number; p50StartupMs: number }> {
    const summary: Record<string, { score: number; state: SourceState; stalls: number; p50StartupMs: number }> = {};
    for (const [key, vec] of this.sources.entries()) {
      summary[key] = {
        score: vec.score,
        state: vec.state,
        stalls: Math.round(vec.stalls),
        p50StartupMs: vec.startupP50Ms
      };
    }
    return summary;
  }

  /**
   * Persists only the sources worth remembering. Carrying known-bad endpoints
   * across a restart is what stops the app from re-discovering the same dead CDN
   * on every cold boot; healthy ones need no record.
   */
  private persist(): void {
    try {
      const now = Date.now();
      const entries: any[] = [];
      for (const vec of this.sources.values()) {
        if (vec.score >= 70) continue;
        if (now - Math.max(vec.lastFailureAt, vec.lastHealthyAt) > 24 * 3600 * 1000) continue;
        entries.push({
          k: vec.endpointKey,
          h: vec.hostKey,
          cf: vec.consecutiveFailures,
          lf: vec.lastFailureAt,
          p50: vec.startupP50Ms
        });
        if (entries.length >= 300) break;
      }
      localStorage.setItem(LS_KEY, JSON.stringify({ at: now, entries }));
    } catch {
      /* quota exceeded or storage disabled */
    }
  }

  private persistThrottled(): void {
    const now = Date.now();
    if (now - this.lastPersistAt < 20000) return;
    this.lastPersistAt = now;
    this.persist();
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return;

      const ageMs = Date.now() - (parsed.at || 0);
      // Yesterday's outage says little about today; drop stale records wholesale.
      if (ageMs > 24 * 3600 * 1000) return;

      // Restored failures are discounted by age so a source that failed hours
      // ago starts merely suspicious rather than condemned.
      const discount = Math.pow(0.5, ageMs / (2 * 3600 * 1000));

      for (const entry of parsed.entries) {
        if (!entry?.k) continue;
        this.sources.set(entry.k, {
          endpointKey: entry.k,
          hostKey: entry.h || entry.k,
          startupSamples: [],
          startupP50Ms: entry.p50 || 0,
          startupP95Ms: 0,
          fragments: 0,
          failedFragments: 0,
          stalls: 0,
          stallDurationMs: 0,
          consecutiveFailures: Math.round((entry.cf || 0) * discount),
          consecutiveSuccesses: 0,
          lastHealthyAt: 0,
          lastFailureAt: entry.lf || 0,
          lastDecayAt: Date.now(),
          openUntil: 0,
          state: 'DEGRADED',
          score: 100
        });
      }
    } catch {
      /* corrupt entry — start clean */
    }
  }
}

export const sourceHealthTracker = new QuantumSourceHealthTracker();
if (typeof window !== 'undefined') {
  (window as any).QuantumSourceHealth = sourceHealthTracker;
}
