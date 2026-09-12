const LS_KEY = 'quantum_resume_v1';

export interface EpisodeRef {
  /** Xtream episode id. */
  id: string;
  title: string;
  season: string;
  episodeNum: number;
  url: string;
  thumb?: string;
  durationSec?: number;
  plot?: string;
}

export interface SeriesContext {
  seriesId: string;
  seriesName: string;
  cover?: string;
  /** Every season number present, ascending. */
  seasons: string[];
  season: string;
  /** Episodes of the active season, in order. */
  episodes: EpisodeRef[];
  /** Index into `episodes` of the one playing. */
  index: number;
}

export interface ResumePoint {
  contentId: string;
  title: string;
  seriesId?: string;
  seriesName?: string;
  season?: string;
  episodeNum?: number;
  url: string;
  thumb?: string;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

/**
 * What the viewer is currently watching within a series, plus where they left
 * off across everything they have watched.
 *
 * Resume position and next-episode autoplay are table stakes on every
 * competing player and were missing here entirely: an episode always restarted
 * from zero and finishing one did nothing. The strip and the episode grid both
 * read from this, so "what plays next" is decided in one place.
 */
export class QuantumSeriesContext {
  private active: SeriesContext | null = null;
  private resume = new Map<string, ResumePoint>();
  private persistTimer: any = null;
  private listeners = new Set<(ctx: SeriesContext | null) => void>();

  constructor() {
    this.restore();
  }

  // --- active series ------------------------------------------------------

  get current(): SeriesContext | null {
    return this.active;
  }

  setActive(ctx: SeriesContext | null): void {
    this.active = ctx;
    for (const fn of this.listeners) {
      try {
        fn(ctx);
      } catch {
        /* a listener must not break playback */
      }
    }
  }

  clearActive(): void {
    this.setActive(null);
  }

  onChange(fn: (ctx: SeriesContext | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Moves the pointer within the active season. */
  setIndex(index: number): EpisodeRef | null {
    if (!this.active) return null;
    if (index < 0 || index >= this.active.episodes.length) return null;
    this.active.index = index;
    this.setActive(this.active);
    return this.active.episodes[index];
  }

  get currentEpisode(): EpisodeRef | null {
    if (!this.active) return null;
    return this.active.episodes[this.active.index] || null;
  }

  /**
   * The episode after the one playing. Returns null at the end of a season
   * rather than rolling into the next one, so autoplay never surprises the
   * viewer with a season boundary.
   */
  get nextEpisode(): EpisodeRef | null {
    if (!this.active) return null;
    return this.active.episodes[this.active.index + 1] || null;
  }

  get previousEpisode(): EpisodeRef | null {
    if (!this.active) return null;
    return this.active.episodes[this.active.index - 1] || null;
  }

  // --- resume points ------------------------------------------------------

  /**
   * Records playback position. Ignores the first and last slice of a title:
   * a few seconds in is not worth resuming, and near the end the viewer has
   * finished and should start the next episode rather than the last minute of
   * this one.
   */
  recordProgress(point: Omit<ResumePoint, 'updatedAt'>): void {
    if (!point.contentId || !point.durationSec || !Number.isFinite(point.durationSec)) return;

    const ratio = point.positionSec / point.durationSec;
    if (point.positionSec < 30 || ratio > 0.95) {
      this.resume.delete(point.contentId);
      this.schedulePersist();
      return;
    }

    this.resume.set(point.contentId, { ...point, updatedAt: Date.now() });
    this.schedulePersist();
  }

  getResume(contentId: string): ResumePoint | null {
    return this.resume.get(contentId) || null;
  }

  markFinished(contentId: string): void {
    if (this.resume.delete(contentId)) this.schedulePersist();
  }

  /** Most recently watched first, for a Continue Watching row. */
  getContinueWatching(limit = 20): ResumePoint[] {
    return [...this.resume.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Serialisable snapshot, so resume state can travel over the LAN link. */
  exportResume(): ResumePoint[] {
    return [...this.resume.values()];
  }

  /**
   * Merges resume points received from a paired device, keeping whichever copy
   * is newer. This is what lets a phone and a TV agree on where a title was
   * left off without any account or cloud service.
   */
  importResume(points: ResumePoint[]): number {
    if (!Array.isArray(points)) return 0;
    let merged = 0;
    for (const p of points) {
      if (!p || !p.contentId || typeof p.updatedAt !== 'number') continue;
      const existing = this.resume.get(p.contentId);
      if (!existing || p.updatedAt > existing.updatedAt) {
        this.resume.set(p.contentId, p);
        merged++;
      }
    }
    if (merged) this.schedulePersist();
    return merged;
  }

  // --- persistence --------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    // Progress ticks once a second during playback; batching keeps that off the
    // main thread's critical path.
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 3000);
  }

  private persist(): void {
    try {
      const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
      const keep = [...this.resume.values()]
        .filter(p => p.updatedAt > cutoff)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 300);
      localStorage.setItem(LS_KEY, JSON.stringify(keep));
    } catch {
      /* quota exceeded or storage disabled */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const p of parsed) {
        if (p && p.contentId) this.resume.set(p.contentId, p);
      }
    } catch {
      /* corrupt entry — start clean */
    }
  }
}

export const seriesContext = new QuantumSeriesContext();
if (typeof window !== 'undefined') {
  (window as any).seriesContext = seriesContext;
}
