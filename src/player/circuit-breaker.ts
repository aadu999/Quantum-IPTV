import { CircuitBreakerHostInfo } from '../types';
import { sourceHealthTracker } from './source-health';

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
    info.failures += 1;

    if (info.failures >= this.maxFailures) {
      info.state = 'OPEN';
      info.nextAttempt = Date.now() + this.cooldownMs;
    }
    this.hosts.set(host, info);
    sourceHealthTracker.recordFailure(url, reason);
  }

  reset(url?: string): void {
    if (url) {
      const host = this.getHost(url);
      this.hosts.delete(host);
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
