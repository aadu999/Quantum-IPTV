const LS_KEY = 'quantum_net_estimate_v1';

/**
 * Exponentially weighted moving average where the decay is expressed as a
 * half-life measured in sample weight (seconds of media downloaded), not in
 * sample count. Weighting by transfer duration means a 6-second fragment
 * influences the estimate six times as much as a 1-second one, which is what
 * makes the estimate stable across variable segment durations.
 *
 * The zero-weight correction removes the startup bias that would otherwise
 * make the first few samples read far lower than reality.
 */
class Ewma {
  private readonly alpha: number;
  private estimate = 0;
  private totalWeight = 0;

  constructor(halfLife: number) {
    this.alpha = halfLife > 0 ? Math.exp(Math.log(0.5) / halfLife) : 0;
  }

  sample(weight: number, value: number): void {
    const adjustedAlpha = Math.pow(this.alpha, weight);
    this.estimate = value * (1 - adjustedAlpha) + adjustedAlpha * this.estimate;
    this.totalWeight += weight;
  }

  get value(): number {
    const zeroFactor = 1 - Math.pow(this.alpha, this.totalWeight);
    return zeroFactor > 0 ? this.estimate / zeroFactor : 0;
  }

  get weight(): number {
    return this.totalWeight;
  }

  reset(): void {
    this.estimate = 0;
    this.totalWeight = 0;
  }
}

export interface NetworkSnapshot {
  bandwidth: number;
  fastBandwidth: number;
  slowBandwidth: number;
  rttMs: number;
  bufferSlope: number;
  samples: number;
  confident: boolean;
  effectiveType?: string;
}

const DEFAULT_BANDWIDTH = 4_000_000;
const MIN_BANDWIDTH = 200_000;
const MAX_BANDWIDTH = 200_000_000;

export class QuantumNetworkEstimator {
  /** Reacts within a couple of seconds of transfer — catches sudden congestion. */
  private fast = new Ewma(3);
  /** Long memory — keeps a single slow fragment from tanking the estimate. */
  private slow = new Ewma(12);
  private rtt = new Ewma(6);

  public lastBufferLevel = 0;
  public lastCheckTime = Date.now();
  public bufferSlope = 0;
  /** Conservative estimate in bits per second, safe to feed straight into ABR. */
  public bandwidth = DEFAULT_BANDWIDTH;

  private sampleCount = 0;
  private lastPersistAt = 0;

  constructor() {
    this.restore();
    this.watchConnectionChanges();
  }

  /**
   * @param bytes  payload size of the completed transfer
   * @param ms     wall-clock duration of the transfer
   * @param ttfbMs optional time-to-first-byte, used for the latency estimate
   */
  recordSample(bytes: number, ms: number, ttfbMs?: number): void {
    // Sub-50ms transfers are dominated by connection setup and cache hits; they
    // report absurd throughput and would poison the estimate.
    if (ms <= 50 || bytes <= 0) return;

    const bps = (bytes * 8 * 1000) / ms;
    if (!Number.isFinite(bps) || bps <= 0) return;

    // Weight by seconds spent transferring so long downloads dominate.
    const weight = ms / 1000;
    this.fast.sample(weight, bps);
    this.slow.sample(weight, bps);
    this.sampleCount++;

    if (typeof ttfbMs === 'number' && ttfbMs >= 0 && ttfbMs < 30000) {
      this.rtt.sample(1, ttfbMs);
    }

    this.recompute();
    this.persistThrottled();
  }

  private recompute(): void {
    const fast = this.fast.value;
    const slow = this.slow.value;

    let estimate: number;
    if (this.slow.weight < 1) {
      // Not enough data yet — hold the restored/default estimate.
      return;
    } else if (fast > 0 && slow > 0) {
      // Taking the minimum makes the estimator quick to panic and slow to
      // relax: throughput drops are believed immediately, recoveries must
      // persist long enough to move the slow average.
      estimate = Math.min(fast, slow);
    } else {
      estimate = Math.max(fast, slow);
    }

    this.bandwidth = Math.max(MIN_BANDWIDTH, Math.min(MAX_BANDWIDTH, estimate));
  }

  /**
   * Bandwidth discounted by a safety factor, for decisions that must not
   * over-commit (choosing a start level, deciding whether to down-switch).
   */
  getSafeEstimate(safetyFactor = 0.8): number {
    const confident = this.isConfident();
    return Math.max(MIN_BANDWIDTH, this.bandwidth * (confident ? safetyFactor : safetyFactor * 0.7));
  }

  isConfident(): boolean {
    return this.slow.weight >= 4 && this.sampleCount >= 3;
  }

  get rttMs(): number {
    const v = this.rtt.value;
    return v > 0 ? v : 150;
  }

  updateBufferSlope(currentBufferSec: number): number {
    const now = Date.now();
    const dt = (now - this.lastCheckTime) / 1000;
    if (dt >= 0.5) {
      // Clamp dt: a backgrounded tab can produce a multi-minute gap that would
      // otherwise yield a meaningless near-zero slope.
      const effectiveDt = Math.min(dt, 5);
      this.bufferSlope = (currentBufferSec - this.lastBufferLevel) / effectiveDt;
      this.lastBufferLevel = currentBufferSec;
      this.lastCheckTime = now;
    }
    return this.bufferSlope;
  }

  /**
   * Seconds until the buffer drains at the current rate, or Infinity when the
   * buffer is stable or growing. Drives pre-emptive recovery — acting while
   * there is still buffer left is what keeps a stall invisible to the viewer.
   */
  getTimeToStarvation(currentBufferSec: number): number {
    if (this.bufferSlope >= -0.05) return Infinity;
    return currentBufferSec / Math.abs(this.bufferSlope);
  }

  getSnapshot(): NetworkSnapshot {
    return {
      bandwidth: this.bandwidth,
      fastBandwidth: this.fast.value,
      slowBandwidth: this.slow.value,
      rttMs: this.rttMs,
      bufferSlope: this.bufferSlope,
      samples: this.sampleCount,
      confident: this.isConfident(),
      effectiveType: this.getEffectiveType()
    };
  }

  private getEffectiveType(): string | undefined {
    try {
      return (navigator as any)?.connection?.effectiveType;
    } catch {
      return undefined;
    }
  }

  /**
   * A transport change (wifi -> cellular) invalidates the learned throughput
   * entirely, so the averages are dropped rather than slowly re-converged.
   */
  private watchConnectionChanges(): void {
    try {
      const conn = (navigator as any)?.connection;
      if (!conn || typeof conn.addEventListener !== 'function') return;
      conn.addEventListener('change', () => {
        this.fast.reset();
        this.slow.reset();
        this.sampleCount = 0;
        this.bandwidth = this.bandwidthForEffectiveType(conn.effectiveType) || DEFAULT_BANDWIDTH;
      });
    } catch {
      /* connection API unavailable */
    }
  }

  private bandwidthForEffectiveType(effectiveType?: string): number | null {
    switch (effectiveType) {
      case 'slow-2g':
        return 250_000;
      case '2g':
        return 500_000;
      case '3g':
        return 1_500_000;
      case '4g':
        return 6_000_000;
      default:
        return null;
    }
  }

  private persistThrottled(): void {
    const now = Date.now();
    if (now - this.lastPersistAt < 15000) return;
    this.lastPersistAt = now;
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ bandwidth: Math.round(this.bandwidth), rttMs: Math.round(this.rttMs), at: now })
      );
    } catch {
      /* storage full or disabled */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // A week-old measurement says nothing about today's network.
      if (!parsed || Date.now() - (parsed.at || 0) > 7 * 24 * 3600 * 1000) return;
      if (typeof parsed.bandwidth === 'number' && parsed.bandwidth > MIN_BANDWIDTH) {
        this.bandwidth = Math.min(MAX_BANDWIDTH, parsed.bandwidth);
      }
    } catch {
      /* corrupt entry — fall back to the default */
    }
  }

  /** Legacy accessor retained for callers that read the raw sample list. */
  get samples(): number[] {
    return [this.fast.value, this.slow.value].filter(v => v > 0);
  }
}

export const networkEstimator = new QuantumNetworkEstimator();
(window as any).networkEstimator = networkEstimator;
