export class QuantumNetworkEstimator {
  public samples: number[];
  public lastBufferLevel: number;
  public lastCheckTime: number;
  public bufferSlope: number;
  public bandwidth: number;

  constructor() {
    this.samples = [];
    this.lastBufferLevel = 0;
    this.lastCheckTime = Date.now();
    this.bufferSlope = 0;
    this.bandwidth = 5000000; // default 5 Mbps
  }

  recordSample(bytes: number, ms: number): void {
    if (ms <= 0) return;
    const bps = (bytes * 8 * 1000) / ms;
    this.samples.push(bps);
    if (this.samples.length > 10) this.samples.shift();
    this.bandwidth = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  updateBufferSlope(currentBufferSec: number): number {
    const now = Date.now();
    const dt = (now - this.lastCheckTime) / 1000;
    if (dt > 0.5) {
      this.bufferSlope = (currentBufferSec - this.lastBufferLevel) / dt;
      this.lastBufferLevel = currentBufferSec;
      this.lastCheckTime = now;
    }
    return this.bufferSlope;
  }
}

export const networkEstimator = new QuantumNetworkEstimator();
(window as any).networkEstimator = networkEstimator;
