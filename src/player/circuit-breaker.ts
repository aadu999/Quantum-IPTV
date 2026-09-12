import { CircuitBreakerHostInfo } from '../types';
import { sourceHealthTracker } from './source-health';

/**
 * Host-level breaker sitting above the per-endpoint health tracker.
 *
 * Endpoint health answers "is this stream bad"; this answers "is this whole
 * origin bad". The distinction matters on IPTV playlists where a hundred
 * channels share one CDN: once that CDN goes down, trying each channel in turn
 * wastes several seconds per attempt before anything else is considered.
 *
 * The previous version tracked failures per host but `isAvailable()` delegated
 * entirely to the endpoint tracker, so the host state was computed and then
 * ignored — the breaker could never actually open.
 */
export class QuantumCircuitBreaker {
  public hosts: Map<string, CircuitBreakerHostInfo>;
  public maxFailures: number;
  public cooldownMs: number;

  constructor(maxFailures = 6, cooldownMs = 12000) {
    this.hosts = new Map();
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
  }

  getHost(url: string): string {
    return sourceHealthTracker.getHostKey(url);
  }

  getEndpoint(url: string): string {
    return sourceHealthTracker.getEndpointKey(url);
  }

  isAvailable(url: string): boolean {
    const info = this.hosts.get(this.getHost(url));

    if (info && info.state === 'OPEN') {
      if (Date.now() < info.nextAttempt) {
        return false;
      }
      // Cooldown elapsed: allow a single probe through. Whether it succeeds is
      // decided by recordSuccess/recordFailure below.
      info.state = 'HALF_OPEN';
    }

    if (info && info.state === 'HALF_OPEN') {
      // While probing, the endpoint's own score still gets a say — no point
      // probing a host through a stream that is independently known bad.
      return sourceHealthTracker.isAvailable(url);
    }

    return sourceHealthTracker.isAvailable(url);
  }

  recordSuccess(url: string, startupTimeMs?: number): void {
    const host = this.getHost(url);
    this.hosts.set(host, { state: 'CLOSED', failures: 0, nextAttempt: 0 });
    sourceHealthTracker.recordSuccess(url, startupTimeMs);
  }

  recordFailure(url: string, reason?: string): void {
    const host = this.getHost(url);
    const info = this.hosts.get(host) || { state: 'CLOSED', failures: 0, nextAttempt: 0 };

    // A failed probe re-opens immediately, and for longer each time.
    if (info.state === 'HALF_OPEN') {
      info.failures += 1;
      info.state = 'OPEN';
      info.nextAttempt = Date.now() + this.backoffFor(info.failures);
    } else {
      info.failures += 1;
      if (info.failures >= this.maxFailures) {
        info.state = 'OPEN';
        info.nextAttempt = Date.now() + this.backoffFor(info.failures);
      }
    }

    this.hosts.set(host, info);
    sourceHealthTracker.recordFailure(url, reason);
  }

  /** Exponential with jitter, so channels sharing a dead CDN do not retry in lockstep. */
  private backoffFor(failures: number): number {
    const exponent = Math.min(4, Math.max(0, failures - this.maxFailures));
    return Math.min(180000, this.cooldownMs * Math.pow(2, exponent)) + Math.random() * 2000;
  }

  getHostState(url: string): CircuitBreakerHostInfo['state'] {
    return this.hosts.get(this.getHost(url))?.state || 'CLOSED';
  }

  reset(url?: string): void {
    if (url) {
      this.hosts.delete(this.getHost(url));
      sourceHealthTracker.reset(url);
    } else {
      this.hosts.clear();
      sourceHealthTracker.reset();
    }
  }

  getHealthScore(url: string): number {
    return sourceHealthTracker.calculateScore(url);
  }
}

export const circuitBreaker = new QuantumCircuitBreaker();
if (typeof window !== 'undefined') {
  (window as any).circuitBreaker = circuitBreaker;
}
