import { Channel } from '../types';

const LS_KEY = 'quantum_channel_reliability_v1';

/**
 * 0 = plays (or never tried), 1 = unreliable, 2 = believed dead.
 * Untried channels deliberately sit in tier 0: absence of evidence is not
 * evidence of failure, and demoting everything unseen would scramble the
 * provider's own ordering on first run.
 */
export type ChannelTier = 0 | 1 | 2;

interface ChannelRecord {
  /** Consecutive failed tune attempts. */
  fails: number;
  /** Times the channel has actually rendered a frame. */
  plays: number;
  lastFailAt: number;
  lastPlayAt: number;
}

/**
 * Tracks which channels actually play.
 *
 * Large IPTV playlists are full of entries that are listed but permanently
 * dead, and they sit interleaved with working channels so the viewer discovers
 * them one timeout at a time. The stream engine already knows the outcome of
 * every tune attempt; this records it per channel so the list can order itself
 * by what has genuinely worked.
 *
 * Deliberately keyed by channel id and backed by plain Map lookups: the filter
 * runs on every search keystroke over the whole catalogue, so it cannot afford
 * the URL parsing that per-source health scoring does.
 */
export class QuantumChannelReliability {
  private records = new Map<string, ChannelRecord>();
  private dirty = false;
  private persistTimer: any = null;

  constructor() {
    this.restore();
  }

  private get(id: string): ChannelRecord | undefined {
    return this.records.get(id);
  }

  private touch(id: string): ChannelRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = { fails: 0, plays: 0, lastFailAt: 0, lastPlayAt: 0 };
      this.records.set(id, rec);
    }
    return rec;
  }

  /** Called when a channel renders its first frame. */
  recordPlayed(id: string): void {
    if (!id) return;
    const rec = this.touch(id);
    rec.plays += 1;
    rec.fails = 0;          // a success clears the strike count outright
    rec.lastPlayAt = Date.now();
    this.schedulePersist();
  }

  /** Called when every source for a channel has been exhausted. */
  recordFailed(id: string): void {
    if (!id) return;
    const rec = this.touch(id);
    rec.fails += 1;
    rec.lastFailAt = Date.now();
    this.schedulePersist();
  }

  getTier(channel: Channel | null | undefined): ChannelTier {
    if (!channel) return 0;
    const rec = this.get(channel.id);
    if (!rec) return 0;

    // A channel that has ever played is given the benefit of the doubt until it
    // fails repeatedly; transient CDN outages should not bury a good channel.
    if (rec.plays > 0) {
      return rec.fails >= 3 ? 1 : 0;
    }
    if (rec.fails >= 3) return 2;
    if (rec.fails >= 1) return 1;
    return 0;
  }

  /** Human-readable reason, for the row badge's tooltip. */
  describe(channel: Channel | null | undefined): string | null {
    if (!channel) return null;
    const rec = this.get(channel.id);
    if (!rec || rec.fails === 0) return null;
    if (rec.plays > 0) {
      return `Failed ${rec.fails} time${rec.fails > 1 ? 's' : ''} recently, but has played before`;
    }
    return `Never played — ${rec.fails} failed attempt${rec.fails > 1 ? 's' : ''}`;
  }

  /** Clears the record for one channel, or all of them. */
  reset(id?: string): void {
    if (id) this.records.delete(id);
    else this.records.clear();
    this.schedulePersist();
  }

  get stats(): { tracked: number; dead: number; flaky: number } {
    let dead = 0;
    let flaky = 0;
    for (const rec of this.records.values()) {
      if (rec.plays === 0 && rec.fails >= 3) dead++;
      else if (rec.fails > 0) flaky++;
    }
    return { tracked: this.records.size, dead, flaky };
  }

  /**
   * Writes are batched: a failover storm can call recordFailed several times a
   * second, and serialising the whole map each time would stutter playback.
   */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) this.persist();
    }, 4000);
  }

  private persist(): void {
    this.dirty = false;
    try {
      const now = Date.now();
      const out: Record<string, [number, number, number]> = {};
      let written = 0;
      for (const [id, rec] of this.records.entries()) {
        // Only entries that say something worth remembering.
        if (rec.fails === 0 && rec.plays === 0) continue;
        // A month without contact makes the record meaningless.
        if (now - Math.max(rec.lastFailAt, rec.lastPlayAt) > 30 * 24 * 3600 * 1000) continue;
        out[id] = [rec.fails, rec.plays, Math.max(rec.lastFailAt, rec.lastPlayAt)];
        if (++written >= 4000) break;
      }
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch {
      /* quota exceeded or storage disabled */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [id, v] of Object.entries(parsed)) {
        if (!Array.isArray(v)) continue;
        const [fails, plays, at] = v as [number, number, number];
        this.records.set(id, {
          fails: Number(fails) || 0,
          plays: Number(plays) || 0,
          lastFailAt: Number(at) || 0,
          lastPlayAt: Number(plays) > 0 ? Number(at) || 0 : 0
        });
      }
    } catch {
      /* corrupt entry — start clean */
    }
  }
}

export const channelReliability = new QuantumChannelReliability();
if (typeof window !== 'undefined') {
  (window as any).channelReliability = channelReliability;
}
