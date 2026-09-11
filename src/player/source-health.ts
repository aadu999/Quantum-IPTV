import { eventBus } from '../core/event-bus';

export interface SourceHealthVector {
  endpointKey: string;
  hostKey: string;
  startupSamples: number[];
  startupP50Ms: number;
  startupP95Ms: number;
  totalFragments: number;
  failedFragments: number;
  totalStalls: number;
  totalStallDurationMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastHealthyAt: number;
  lastFailureAt: number;
  score: number; // 0 to 100
}

export class QuantumSourceHealthTracker {
  private sources: Map<string, SourceHealthVector> = new Map();
  private hostPenalties: Map<string, number> = new Map();

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
        totalFragments: 0,
        failedFragments: 0,
        totalStalls: 0,
        totalStallDurationMs: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastHealthyAt: Date.now(),
        lastFailureAt: 0,
        score: 100
      };
      this.sources.set(key, vector);
    }
    return vector;
  }

  calculateScore(url: string): number {
    const vector = this.getOrCreate(url);
    let score = 100;

    // 1. Consecutive failure penalty
    if (vector.consecutiveFailures > 0) {
      score -= Math.min(80, vector.consecutiveFailures * 25);
    }

    // 2. Fragment failure rate penalty
    if (vector.totalFragments >= 5) {
      const fragFailureRate = vector.failedFragments / vector.totalFragments;
      score -= Math.min(40, Math.round(fragFailureRate * 80));
    }

    // 3. Excessive stall rate penalty
    if (vector.totalStalls > 0) {
      score -= Math.min(30, vector.totalStalls * 10);
    }

    // 4. Host-level collective degradation penalty
    const hostKey = vector.hostKey;
    const hostPenalty = this.hostPenalties.get(hostKey) || 0;
    score -= hostPenalty;

    // 5. Cooldown recovery
    if (score < 50 && vector.lastFailureAt > 0) {
      const timeSinceFail = Date.now() - vector.lastFailureAt;
      if (timeSinceFail > 12000) {
        // Cooldown passed; boost score for probe attempt
        score = Math.max(score, 50);
      }
    }

    vector.score = Math.max(0, Math.min(100, score));
    return vector.score;
  }

  isAvailable(url: string): boolean {
    const score = this.calculateScore(url);
    return score >= 30;
  }

  recordSuccess(url: string, startupTimeMs?: number): void {
    const vector = this.getOrCreate(url);
    vector.consecutiveFailures = 0;
    vector.consecutiveSuccesses += 1;
    vector.lastHealthyAt = Date.now();

    if (startupTimeMs && startupTimeMs > 0) {
      vector.startupSamples.push(startupTimeMs);
      if (vector.startupSamples.length > 20) vector.startupSamples.shift();

      const sorted = [...vector.startupSamples].sort((a, b) => a - b);
      vector.startupP50Ms = sorted[Math.floor(sorted.length * 0.5)];
      vector.startupP95Ms = sorted[Math.floor(sorted.length * 0.95)];
    }

    // Ease any host-level penalty on success
    const host = vector.hostKey;
    if (this.hostPenalties.has(host)) {
      const penalty = Math.max(0, (this.hostPenalties.get(host) || 0) - 5);
      if (penalty === 0) this.hostPenalties.delete(host);
      else this.hostPenalties.set(host, penalty);
    }

    this.calculateScore(url);
    eventBus.emit('HEALTH_UPDATE', {
      endpointKey: vector.endpointKey,
      score: vector.score,
      status: 'HEALTHY'
    });
  }

  recordFailure(url: string, reason?: string): void {
    const vector = this.getOrCreate(url);
    vector.consecutiveFailures += 1;
    vector.consecutiveSuccesses = 0;
    vector.lastFailureAt = Date.now();

    // Increment host penalty mildly only after multiple endpoint failures
    const host = vector.hostKey;
    if (vector.consecutiveFailures >= 3) {
      const currentPenalty = this.hostPenalties.get(host) || 0;
      this.hostPenalties.set(host, Math.min(40, currentPenalty + 10));
    }

    this.calculateScore(url);
    eventBus.emit('HEALTH_UPDATE', {
      endpointKey: vector.endpointKey,
      score: vector.score,
      status: 'DEGRADED',
      reason
    });
  }

  recordFragment(url: string, success: boolean): void {
    const vector = this.getOrCreate(url);
    vector.totalFragments += 1;
    if (!success) {
      vector.failedFragments += 1;
    }
  }

  recordStall(url: string, durationMs: number): void {
    const vector = this.getOrCreate(url);
    vector.totalStalls += 1;
    vector.totalStallDurationMs += durationMs;
    this.calculateScore(url);
  }

  reset(url?: string): void {
    if (url) {
      const key = this.getEndpointKey(url);
      this.sources.delete(key);
    } else {
      this.sources.clear();
      this.hostPenalties.clear();
    }
  }

  getHealthSummary(): Record<string, { score: number; stalls: number; p50StartupMs: number }> {
    const summary: Record<string, { score: number; stalls: number; p50StartupMs: number }> = {};
    for (const [key, vec] of this.sources.entries()) {
      summary[key] = {
        score: vec.score,
        stalls: vec.totalStalls,
        p50StartupMs: vec.startupP50Ms
      };
    }
    return summary;
  }
}

export const sourceHealthTracker = new QuantumSourceHealthTracker();
if (typeof window !== 'undefined') {
  (window as any).QuantumSourceHealth = sourceHealthTracker;
}
