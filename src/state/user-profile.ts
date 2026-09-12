import { Channel, UserProfileData } from '../types';
import { state } from './store';
import { circuitBreaker } from '../player/circuit-breaker';

export class QuantumUserProfile {
  public profile: UserProfileData;

  constructor() {
    this.profile = JSON.parse(
      localStorage.getItem('quantum_user_profile') ||
        JSON.stringify({
          genres: {},
          languages: {},
          channels: {},
          watchHistory: [],
          totalWatchTimeSec: 0
        })
    );
  }

  save(): void {
    localStorage.setItem('quantum_user_profile', JSON.stringify(this.profile));
  }

  recordWatchEvent(channel: Channel | null, durationSec: number): void {
    if (!channel || durationSec < 3) return;

    const genre = channel.group || 'General';
    const lang = channel.language || 'Unknown';

    this.profile.genres[genre] = (this.profile.genres[genre] || 0) + durationSec;
    this.profile.languages[lang] = (this.profile.languages[lang] || 0) + durationSec;
    this.profile.channels[channel.id] = (this.profile.channels[channel.id] || 0) + 1;
    this.profile.totalWatchTimeSec += durationSec;

    this.profile.watchHistory.unshift({
      id: channel.id,
      name: channel.name,
      timestamp: Date.now(),
      durationSec
    });
    if (this.profile.watchHistory.length > 50) this.profile.watchHistory.pop();

    this.save();
  }

  getTopGenres(): string[] {
    return Object.entries(this.profile.genres)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);
  }

  getTopLanguages(): string[] {
    return Object.entries(this.profile.languages)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);
  }
}

export const userProfile = new QuantumUserProfile();
(window as any).userProfile = userProfile;

/** Watch history older than this contributes nothing to recency scoring. */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000;

export class QuantumDecisionEngine {
  /**
   * Recency-weighted affinity per channel id, rebuilt from watch history.
   *
   * Raw lifetime totals are what the genre/language ranking still uses, and on
   * their own they ossify: a fortnight of watching one channel keeps it top of
   * the list long after the user has moved on. Decaying each history entry by
   * age lets recent behaviour actually move the ranking.
   */
  private recencyByChannel(): Map<string, number> {
    const weights = new Map<string, number>();
    const now = Date.now();

    for (const entry of userProfile.profile.watchHistory || []) {
      if (!entry?.id) continue;
      const age = now - (entry.timestamp || 0);
      if (age < 0) continue;
      const weight = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS) * Math.min(600, entry.durationSec || 0);
      weights.set(entry.id, (weights.get(entry.id) || 0) + weight);
    }
    return weights;
  }

  calculateScore(channel: Channel, recency?: Map<string, number>): number {
    let score = 50;

    const topGenres = userProfile.getTopGenres();
    const topLangs = userProfile.getTopLanguages();

    if (channel.group && topGenres.includes(channel.group)) {
      score += 25 - topGenres.indexOf(channel.group) * 5;
    }
    if (channel.language && topLangs.includes(channel.language)) {
      score += 20 - topLangs.indexOf(channel.language) * 4;
    }

    if (state.favorites && state.favorites.includes(channel.id)) score += 30;

    // Recently watched, weighted by how recently and for how long. Capped so a
    // single marathon session cannot dominate every future ranking.
    const weights = recency || this.recencyByChannel();
    const recencyWeight = weights.get(channel.id) || 0;
    if (recencyWeight > 0) {
      score += Math.min(25, Math.log10(1 + recencyWeight) * 12);
    }

    if (state.offlineChannels && state.offlineChannels.has(channel.id)) score -= 100;

    // Measured health, rather than a flat penalty: a source at 65 is worth
    // recommending below a healthy one but well above a source at 10.
    const health = circuitBreaker.getHealthScore(channel.url);
    score -= Math.round((100 - health) * 0.6);

    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12 && channel.group === 'News') score += 15;
    if (hour >= 18 && hour < 23 && (channel.group === 'Entertainment' || channel.group === 'Sports')) score += 15;

    return Math.max(0, score);
  }

  getRankedRecommendations(limit = 10): Channel[] {
    // Computed once for the whole pass; rebuilding it per channel made this
    // O(channels x history), which is felt on a 6,000-row catalogue.
    const recency = this.recencyByChannel();

    const candidates = state.channels.filter(c => {
      const isOffline = state.offlineChannels && state.offlineChannels.has(c.id);
      const isAvailable = circuitBreaker.isAvailable(c.url);
      return !isOffline && isAvailable;
    });

    return candidates
      .map(c => ({ channel: c, score: this.calculateScore(c, recency) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.channel);
  }

  getRandomSurpriseChannel(): Channel {
    const recommendations = this.getRankedRecommendations(15);
    if (recommendations.length === 0) return state.channels[0];
    // Weight the draw toward the front of the list so "surprise me" stays
    // plausible rather than uniformly random across fifteen candidates.
    const skewed = Math.floor(Math.pow(Math.random(), 1.7) * recommendations.length);
    return recommendations[Math.min(skewed, recommendations.length - 1)];
  }
}

export const decisionEngine = new QuantumDecisionEngine();
(window as any).decisionEngine = decisionEngine;
