export interface ChannelSource {
  url: string;
  sourceName: string;
}

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  country?: string;
  language?: string;
  type?: 'live' | 'vod' | 'series';
  tvgId?: string;
  program?: string;
  sources?: ChannelSource[];
  activeSourceIndex?: number;
  seriesId?: string;
  vodId?: string;
  rating?: string;
  releaseDate?: string;
  genre?: string;
  director?: string;
  cast?: string;
  plot?: string;
  cover?: string;
  duration?: number;
}

export interface CircuitBreakerHostInfo {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  nextAttempt: number;
}

export interface PlaybackEvent {
  state: string;
  time: number;
  [key: string]: any;
}

export interface PlaybackAttempt {
  id: string;
  channelId: string;
  channelName: string;
  url: string;
  startedAt: number;
  events: PlaybackEvent[];
  outcome: string | null;
  reason?: string;
  endedAt?: number;
  durationMs?: number;
}

export interface UserProfileData {
  genres: Record<string, number>;
  languages: Record<string, number>;
  channels: Record<string, number>;
  watchHistory: Array<{
    id: string;
    name: string;
    timestamp: number;
    durationSec: number;
  }>;
  totalWatchTimeSec: number;
}

export interface SessionData {
  lastChannelIndex?: number;
  lastChannelId?: string;
  lastChannelUrl?: string;
  providerType?: 'xtream' | 'm3u' | 'stalker' | 'none';
  xtreamHost?: string;
  xtreamUser?: string;
  xtreamPass?: string;
  customM3uUrl?: string;
  stalkerUrl?: string;
  stalkerMac?: string;
  xmltvUrl?: string;
}

export interface AppState {
  channels: Channel[];
  filteredChannels: Channel[];
  currentChannelIndex: number;
  selectedGroup: string;
  selectedLanguage: string;
  searchQuery: string;
  activeFilter: 'all' | 'live' | 'movies' | 'series' | 'favs';
  favorites: string[];
  offlineChannels: Set<string>;
  aspectModes: string[];
  aspectIndex: number;
  isRemoteClient: boolean;
  tvDeviceId: string;
  remotePairingCode: string;
  lastXtreamHost?: string;
  lastXtreamUser?: string;
  lastXtreamPass?: string;
  isTheaterMode?: boolean;
}
