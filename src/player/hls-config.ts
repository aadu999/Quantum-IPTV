import Hls, { HlsConfig } from 'hls.js';

/**
 * Enterprise-grade Hls.js configuration specifically tuned for resilient IPTV streaming.
 * Eliminates stutters, provides smooth ABR transitions, prevents buffer starvation,
 * and maintains continuous playback across fluctuating network conditions.
 */
export function createHlsConfig(): Partial<HlsConfig> {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    maxBufferSize: 60 * 1000 * 1000,
    liveSyncDurationCount: 4,
    liveMaxLatencyDurationCount: 10,
    liveDurationInfinity: true,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 5,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 64000,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 5,
    levelLoadingRetryDelay: 1000,
    fragLoadingTimeOut: 20000,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryTimeout: 64000,
    startLevel: -1,
    testBandwidth: true,
    progressive: true,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    autoStartLoad: true
  };
}
