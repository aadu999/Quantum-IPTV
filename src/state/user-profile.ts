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

export class QuantumDecisionEngine {
  calculateScore(channel: Channel): number {
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

    if (state.offlineChannels && state.offlineChannels.has(channel.id)) score -= 100;
    if (!circuitBreaker.isAvailable(channel.url)) score -= 80;

    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12 && channel.group === 'News') score += 15;
    if (hour >= 18 && hour < 23 && (channel.group === 'Entertainment' || channel.group === 'Sports')) score += 15;

    return Math.max(0, score);
  }

  getRankedRecommendations(limit = 10): Channel[] {
    const candidates = state.channels.filter(c => {
      const isOffline = state.offlineChannels && state.offlineChannels.has(c.id);
      const isAvailable = circuitBreaker.isAvailable(c.url);
      return !isOffline && isAvailable;
    });

    return candidates
      .map(c => ({ channel: c, score: this.calculateScore(c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.channel);
  }

  getRandomSurpriseChannel(): Channel {
    const recommendations = this.getRankedRecommendations(15);
    if (recommendations.length === 0) return state.channels[0];
    const randomIndex = Math.floor(Math.random() * recommendations.length);
    return recommendations[randomIndex];
  }
}

export const decisionEngine = new QuantumDecisionEngine();
(window as any).decisionEngine = decisionEngine;
