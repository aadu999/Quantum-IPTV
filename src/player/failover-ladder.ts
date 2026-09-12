import { Channel } from '../types';
import { sourceHealthTracker } from './source-health';
import { circuitBreaker } from './circuit-breaker';
import { getProxiedUrl, shouldProxy } from '../services/proxy';

export interface FailoverCandidate {
  url: string;
  /** URL actually handed to the player, after any proxy rewrite. */
  targetUrl: string;
  sourceName: string;
  proxied: boolean;
  /** Index into `channel.sources`, or -1 for the channel's own url. */
  sourceIndex: number;
  score: number;
}

/**
 * Builds the ordered list of things to try for one channel.
 *
 * The old failover was a fixed three-step chain hard-coded inside the engine:
 * walk `sources` forward by index, then try the proxy once, then give up. That
 * ignored per-source health entirely (a source known to have failed thirty
 * seconds ago was still tried first, in playlist order), and it could only ever
 * proxy the *last* source it happened to be sitting on.
 *
 * Building an explicit ladder instead means: every source is ranked by measured
 * health, each one gets both a direct and a proxied attempt, and the whole
 * sequence is known up front so the engine can simply walk it.
 */
export function buildFailoverLadder(channel: Channel | null, currentUrl?: string): FailoverCandidate[] {
  if (!channel) return [];

  const sources: Array<{ url: string; sourceName: string; sourceIndex: number }> = [];
  const seenUrls = new Set<string>();

  const push = (url: string, sourceName: string, sourceIndex: number) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    sources.push({ url, sourceName, sourceIndex });
  };

  if (Array.isArray(channel.sources) && channel.sources.length > 0) {
    channel.sources.forEach((source, index) => push(source.url, source.sourceName || `Source ${index + 1}`, index));
  }
  // The channel's own url may not appear in `sources` (hand-tuned entries,
  // Xtream VOD, anything added via tuneToChannel).
  push(channel.url, 'Primary', -1);

  // Rank by health. Ties keep playlist order, which is usually the provider's
  // own preference, and a stable sort preserves that.
  const ranked = sources
    .map(source => ({ ...source, score: sourceHealthTracker.calculateScore(source.url) }))
    .sort((a, b) => b.score - a.score);

  const candidates: FailoverCandidate[] = [];

  for (const source of ranked) {
    // Mixed-content and CORS rules can make the direct attempt structurally
    // impossible; in that case the proxied form is the only real candidate.
    const directImpossible = shouldProxy(source.url);

    if (!directImpossible) {
      candidates.push({
        url: source.url,
        targetUrl: source.url,
        sourceName: source.sourceName,
        proxied: false,
        sourceIndex: source.sourceIndex,
        score: source.score
      });
    }

    candidates.push({
      url: source.url,
      targetUrl: getProxiedUrl(source.url),
      sourceName: directImpossible ? source.sourceName : `${source.sourceName} via Proxy`,
      proxied: true,
      sourceIndex: source.sourceIndex,
      score: source.score - 1
    });
  }

  // Hosts whose breaker is open go to the back rather than being dropped: if
  // every source for a channel is on a struggling CDN, a low-probability attempt
  // still beats showing the viewer nothing.
  const available: FailoverCandidate[] = [];
  const deprioritised: FailoverCandidate[] = [];
  for (const candidate of candidates) {
    (circuitBreaker.isAvailable(candidate.url) ? available : deprioritised).push(candidate);
  }

  const ladder = [...available, ...deprioritised];

  // Whatever just failed should not be the very next thing retried.
  if (currentUrl) {
    const failedIndex = ladder.findIndex(c => c.targetUrl === currentUrl);
    if (failedIndex === 0 && ladder.length > 1) {
      const [failed] = ladder.splice(0, 1);
      ladder.push(failed);
    }
  }

  return ladder;
}
