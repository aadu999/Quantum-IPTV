import { eventBus } from './event-bus';

export interface PlaybackAttemptRecord {
  attemptId: string;
  sourceUrl: string;
  sourceName?: string;
  isProxied: boolean;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  outcome?: 'SUCCESS' | 'FAILED' | 'ABORTED';
  failReason?: string;
}

export interface PlaybackSession {
  sessionId: string;
  contentId: string;
  contentName: string;
  userIntentTimestamp: number;
  firstFrameTimestamp: number | null;
  zapToFrameMs: number | null;
  networkContext: {
    estimatedBandwidth: number;
    effectiveType?: string;
  };
  attempts: PlaybackAttemptRecord[];
  outcome: 'PLAYING' | 'STALLED' | 'FAILED' | 'TERMINATED' | null;
  totalStalls: number;
  totalStallDurationMs: number;
  createdAt: number;
  endedAt?: number;
}

export class QuantumSessionManager {
  private activeSession: PlaybackSession | null = null;
  private sessionHistory: PlaybackSession[] = [];
  private maxHistory = 50;

  startSession(
    contentId: string,
    contentName: string,
    userIntentTimestamp: number = Date.now(),
    networkContext: { estimatedBandwidth: number; effectiveType?: string } = { estimatedBandwidth: 5000000 }
  ): PlaybackSession {
    if (this.activeSession) {
      this.endSession('TERMINATED');
    }

    const sessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const session: PlaybackSession = {
      sessionId,
      contentId,
      contentName,
      userIntentTimestamp,
      firstFrameTimestamp: null,
      zapToFrameMs: null,
      networkContext,
      attempts: [],
      outcome: null,
      totalStalls: 0,
      totalStallDurationMs: 0,
      createdAt: Date.now()
    };

    this.activeSession = session;

    eventBus.emit('PLAY_INTENT', {
      sessionId,
      contentId,
      contentName,
      intentTime: userIntentTimestamp
    }, { sessionId, contentId });

    return session;
  }

  getActiveSession(): PlaybackSession | null {
    return this.activeSession;
  }

  recordAttempt(sourceUrl: string, sourceName?: string, isProxied = false): PlaybackAttemptRecord {
    const attempt: PlaybackAttemptRecord = {
      attemptId: `att_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      sourceUrl,
      sourceName,
      isProxied,
      startedAt: Date.now()
    };

    if (this.activeSession) {
      this.activeSession.attempts.push(attempt);
      eventBus.emit('SOURCE_SELECTED', {
        attemptId: attempt.attemptId,
        sourceUrl,
        sourceName,
        isProxied
      }, { sessionId: this.activeSession.sessionId, contentId: this.activeSession.contentId });
    }

    return attempt;
  }

  recordFirstFrame(): number | null {
    if (!this.activeSession) return null;

    if (!this.activeSession.firstFrameTimestamp) {
      const now = Date.now();
      this.activeSession.firstFrameTimestamp = now;
      this.activeSession.zapToFrameMs = Math.max(0, now - this.activeSession.userIntentTimestamp);
      this.activeSession.outcome = 'PLAYING';

      const currentAttempt = this.activeSession.attempts[this.activeSession.attempts.length - 1];
      if (currentAttempt) {
        currentAttempt.outcome = 'SUCCESS';
        currentAttempt.endedAt = now;
        currentAttempt.durationMs = now - currentAttempt.startedAt;
      }

      eventBus.emit('FIRST_FRAME', {
        sessionId: this.activeSession.sessionId,
        contentId: this.activeSession.contentId,
        zapToFrameMs: this.activeSession.zapToFrameMs,
        attemptsCount: this.activeSession.attempts.length
      }, { sessionId: this.activeSession.sessionId, contentId: this.activeSession.contentId });

      console.log(`[QuantumSession] First frame rendered. Zap-to-Frame: ${this.activeSession.zapToFrameMs}ms`);
    }

    return this.activeSession.zapToFrameMs;
  }

  recordStall(durationMs: number): void {
    if (!this.activeSession) return;
    this.activeSession.totalStalls += 1;
    this.activeSession.totalStallDurationMs += durationMs;
    this.activeSession.outcome = 'STALLED';
  }

  endSession(outcome: 'PLAYING' | 'STALLED' | 'FAILED' | 'TERMINATED'): void {
    if (!this.activeSession) return;

    this.activeSession.outcome = outcome;
    this.activeSession.endedAt = Date.now();

    const lastAttempt = this.activeSession.attempts[this.activeSession.attempts.length - 1];
    if (lastAttempt && !lastAttempt.outcome) {
      lastAttempt.outcome = outcome === 'PLAYING' ? 'SUCCESS' : 'FAILED';
      lastAttempt.endedAt = Date.now();
      lastAttempt.durationMs = lastAttempt.endedAt - lastAttempt.startedAt;
    }

    eventBus.emit('PLAYBACK_ENDED', {
      sessionId: this.activeSession.sessionId,
      contentId: this.activeSession.contentId,
      outcome,
      zapToFrameMs: this.activeSession.zapToFrameMs,
      totalStalls: this.activeSession.totalStalls,
      totalStallDurationMs: this.activeSession.totalStallDurationMs,
      sessionDurationMs: this.activeSession.endedAt - this.activeSession.createdAt
    }, { sessionId: this.activeSession.sessionId, contentId: this.activeSession.contentId });

    this.sessionHistory.unshift(this.activeSession);
    if (this.sessionHistory.length > this.maxHistory) {
      this.sessionHistory.pop();
    }

    this.activeSession = null;
  }

  getMetricsSummary(): {
    totalSessions: number;
    avgZapToFrameMs: number;
    p50ZapToFrameMs: number;
    p95ZapToFrameMs: number;
    stallRatePercent: number;
  } {
    const validZtfs = this.sessionHistory
      .map(s => s.zapToFrameMs)
      .filter((z): z is number => typeof z === 'number' && z > 0)
      .sort((a, b) => a - b);

    const totalSessions = this.sessionHistory.length;
    const avgZapToFrameMs = validZtfs.length
      ? Math.round(validZtfs.reduce((a, b) => a + b, 0) / validZtfs.length)
      : 0;
    const p50ZapToFrameMs = validZtfs.length
      ? validZtfs[Math.floor(validZtfs.length * 0.5)]
      : 0;
    const p95ZapToFrameMs = validZtfs.length
      ? validZtfs[Math.floor(validZtfs.length * 0.95)]
      : 0;

    const stalledSessions = this.sessionHistory.filter(s => s.totalStalls > 0).length;
    const stallRatePercent = totalSessions ? Math.round((stalledSessions / totalSessions) * 100) : 0;

    return {
      totalSessions,
      avgZapToFrameMs,
      p50ZapToFrameMs,
      p95ZapToFrameMs,
      stallRatePercent
    };
  }
}

export const sessionManager = new QuantumSessionManager();
if (typeof window !== 'undefined') {
  (window as any).QuantumSessionManager = sessionManager;
}
