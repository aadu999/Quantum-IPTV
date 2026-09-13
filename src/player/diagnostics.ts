export interface RungRecord {
  /** Stable handle, so an async probe can find its rung after the attempt ends. */
  id: number;
  at: number;
  sourceName: string;
  url: string;
  proxied: boolean;
  /** Why the engine moved on from this rung. */
  reason: string;
  /** HTMLMediaElement.error code, when the element reported one. */
  mediaErrorCode?: number;
  /** HTTP status discovered by probing the URL after the failure. */
  httpStatus?: number;
  httpNote?: string;
}

export interface AttemptDiagnostic {
  contentName: string;
  contentUrl: string;
  startedAt: number;
  rungs: RungRecord[];
  outcome?: 'PLAYING' | 'FAILED';
}

/**
 * Human-readable explanation of a failed playback attempt.
 *
 * IPTV failures are opaque by nature: the element reports a generic decode
 * error, the panel returns a status the player never surfaces, and the viewer
 * sees a spinner followed by "offline". Recording what each rung actually hit --
 * and probing the URL afterwards for the HTTP status the media element hides --
 * turns that into a specific, actionable sentence.
 */
export class QuantumPlaybackDiagnostics {
  private attempts: AttemptDiagnostic[] = [];
  private current: AttemptDiagnostic | null = null;
  private maxHistory = 20;
  private nextRungId = 1;

  begin(contentName: string, contentUrl: string): void {
    this.current = { contentName, contentUrl, startedAt: Date.now(), rungs: [] };
  }

  /** @returns a token for annotating this rung once a probe completes. */
  recordRung(rec: Omit<RungRecord, 'at' | 'id'>): number {
    if (!this.current) this.begin('Unknown', rec.url);
    const id = this.nextRungId++;
    this.current!.rungs.push({ ...rec, id, at: Date.now() });
    return id;
  }

  /**
   * Attaches a probe result to a specific rung.
   *
   * Addressed by token rather than "the last one", because the probe is async
   * and the final rung's failure closes the attempt immediately: annotating the
   * current attempt dropped the status of the very last rung, which is the one
   * that explains the failure. Searching recent attempts also survives the
   * viewer starting something else while a probe is still in flight.
   */
  annotateRung(id: number, patch: Partial<RungRecord>): void {
    const pools = this.current ? [this.current, ...this.attempts] : this.attempts;
    for (const attempt of pools) {
      const rung = attempt.rungs.find(r => r.id === id);
      if (rung) {
        Object.assign(rung, patch);
        return;
      }
    }
  }

  end(outcome: 'PLAYING' | 'FAILED'): void {
    if (!this.current) return;
    this.current.outcome = outcome;
    this.attempts.unshift(this.current);
    if (this.attempts.length > this.maxHistory) this.attempts.pop();
    this.current = null;
  }

  get lastAttempt(): AttemptDiagnostic | null {
    return this.current || this.attempts[0] || null;
  }

  /**
   * Turns the recorded rungs into one sentence naming the most likely cause.
   * Ordered by how specific the evidence is: an HTTP status from the panel beats
   * a generic decode error from the element.
   */
  explain(): string {
    const attempt = this.lastAttempt;
    if (!attempt || attempt.rungs.length === 0) return 'No diagnostic information was captured.';

    const statuses = attempt.rungs.map(r => r.httpStatus).filter((s): s is number => typeof s === 'number');
    const has = (code: number) => statuses.includes(code);

    if (has(401) || has(403)) {
      return 'The provider rejected the request (HTTP 401/403). The username, password, or an active-connection limit is the likely cause — check whether another device is already streaming on this account.';
    }
    // Decided before the 404 branches: if any rung fetched successfully and the
    // media still failed, the file is reachable and the container is the
    // problem. A 404 on a speculative alternate extension is expected and must
    // not outrank that.
    const codesEarly = attempt.rungs.map(r => r.mediaErrorCode).filter((c): c is number => typeof c === 'number');
    if (statuses.some(s => s >= 200 && s < 300) && codesEarly.includes(4)) {
      const okExt = (attempt.contentUrl.match(/\.([A-Za-z0-9]+)(?:\?|$)/) || [])[1];
      return `The provider served the file${okExt ? ` as .${okExt}` : ''} and every playable container was tried, but this device could not decode any of them. The container or codec is unsupported here — the stream may still work in a native player such as VLC.`;
    }

    if (statuses.length > 0 && statuses.every(s => s === 404)) {
      return 'The provider returned HTTP 404 for every container tried (.mp4, .m4v, .mov). The episode id exists in the listing but no playable file is published for it, which usually means the title is not actually available on this account.';
    }
    if (has(404)) {
      return 'The provider returned HTTP 404 for the container it advertised. The episode may be published under a different extension than the API reports.';
    }
    if (statuses.some(s => s >= 500)) {
      return 'The provider returned a server error (HTTP 5xx). This is a fault on their side, not in the app.';
    }
    const codes = attempt.rungs.map(r => r.mediaErrorCode).filter((c): c is number => typeof c === 'number');

    // A rung that fetched successfully yet still failed to play tells us the
    // file is reachable and the problem is the media itself. That outcome
    // outranks a failed probe on another rung: a direct request commonly fails
    // CORS in a browser while the proxied one succeeds, and reporting that as
    // "blocked" would hide the real cause.
    const someRungFetchedOk = statuses.some(s => s >= 200 && s < 300);
    if (has(0) && !someRungFetchedOk) {
      return 'The request never completed — blocked, refused, or timed out. On a browser this is usually mixed content or CORS; on the TV it points at the network or the provider being unreachable.';
    }
    // Reached when nothing fetched successfully (so the container could not be
    // confirmed reachable) but the element still reported a decode failure.
    if (codes.includes(4)) {
      const ext = (attempt.contentUrl.match(/\.([A-Za-z0-9]+)(?:\?|$)/) || [])[1];
      if (ext && /mkv|avi|ts|wmv|flv/i.test(ext)) {
        return `The file is served as .${ext}, which this player cannot decode. Matroska, AVI and similar containers are not supported by the system video decoder; the stream itself may be fine in a native player such as VLC.`;
      }
      return 'The media loaded but its format could not be decoded. The codec inside the container is probably unsupported by this device.';
    }
    if (codes.includes(2)) return 'The download failed part-way through (network error).';
    if (codes.includes(3)) return 'The file downloaded but failed to decode — it may be corrupt or truncated on the provider.';

    const reasons = [...new Set(attempt.rungs.map(r => r.reason))].join(', ');
    return `Playback failed after ${attempt.rungs.length} attempt(s). Reported: ${reasons}.`;
  }

  /** Plain-text report, for pasting into a bug report. */
  report(): string {
    const attempt = this.lastAttempt;
    if (!attempt) return 'No playback attempts recorded.';

    const lines: string[] = [];
    lines.push(`Content : ${attempt.contentName}`);
    lines.push(`URL     : ${redact(attempt.contentUrl)}`);
    lines.push(`Outcome : ${attempt.outcome || 'in progress'}`);
    lines.push(`Diagnosis: ${this.explain()}`);
    lines.push('');
    lines.push('Rungs tried:');
    attempt.rungs.forEach((r, i) => {
      const bits = [
        `${i + 1}. ${r.sourceName}`,
        r.proxied ? '[proxied]' : '[direct]',
        `-> ${r.reason}`,
        typeof r.httpStatus === 'number' ? `HTTP ${r.httpStatus}` : '',
        typeof r.mediaErrorCode === 'number' ? `mediaError ${r.mediaErrorCode}` : '',
        r.httpNote || ''
      ].filter(Boolean);
      lines.push('  ' + bits.join(' '));
      lines.push('     ' + redact(r.url));
    });
    return lines.join('\n');
  }
}

/**
 * Xtream stream URLs embed the account's username and password in the path, so
 * a report meant for sharing must not carry them verbatim.
 */
function redact(url: string): string {
  return (
    url
      // Xtream stream paths: /series/<user>/<pass>/<id>.<ext>
      .replace(/\/(series|movie|live)\/([^/]+)\/([^/]+)\//i, '/$1/***/***/')
      // player_api.php and get.php carry the same credentials as query params,
      // which the path rule above does not touch. A report is meant to be
      // shared, so these have to go too.
      .replace(/([?&](?:username|user|password|pass|token|mac)=)[^&#]*/gi, '$1***')
  );
}

export const playbackDiagnostics = new QuantumPlaybackDiagnostics();
if (typeof window !== 'undefined') {
  (window as any).quantumDiagnostics = () => playbackDiagnostics.report();
  (window as any).playbackDiagnostics = playbackDiagnostics;
}
