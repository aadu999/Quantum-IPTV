import { CircuitBreakerHostInfo } from '../types';

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
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  isAvailable(url: string): boolean {
    const host = this.getHost(url);
    const info = this.hosts.get(host);
    if (!info) return true;

    if (info.state === 'OPEN') {
      if (Date.now() > info.nextAttempt) {
        info.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(url: string): void {
    const host = this.getHost(url);
    this.hosts.set(host, { state: 'CLOSED', failures: 0, nextAttempt: 0 });
  }

  recordFailure(url: string): void {
    const host = this.getHost(url);
    const info = this.hosts.get(host) || { state: 'CLOSED', failures: 0, nextAttempt: 0 };
    info.failures += 1;

    if (info.failures >= this.maxFailures) {
      info.state = 'OPEN';
      info.nextAttempt = Date.now() + this.cooldownMs;
    }
    this.hosts.set(host, info);
  }

  reset(url?: string): void {
    if (url) {
      const host = this.getHost(url);
      this.hosts.delete(host);
    } else {
      this.hosts.clear();
    }
  }
}

export const circuitBreaker = new QuantumCircuitBreaker();
(window as any).circuitBreaker = circuitBreaker;
