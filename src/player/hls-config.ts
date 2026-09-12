import { HlsConfig, RetryConfig } from 'hls.js';
import { networkEstimator } from './network-estimator';

/**
 * Retry policy shared by the playlist and fragment loaders.
 *
 * Exponential backoff matters more here than in most players: IPTV origins are
 * frequently overloaded rather than down, and a linear one-second retry storm
 * from every viewer is what keeps them that way. Backing off gives a struggling
 * origin room to answer, and gives the engine's own failover ladder time to
 * take over when it will not.
 */
function retryPolicy(maxNumRetry: number, retryDelayMs: number, maxRetryDelayMs: number): RetryConfig {
  return {
    maxNumRetry,
    retryDelayMs,
    maxRetryDelayMs,
    backoff: 'exponential'
  };
}

/**
 * Detects constrained devices so buffer targets can be scaled down. Cheap Android
 * TV sticks routinely have 1GB of RAM and will have the whole tab killed by the
 * OS if the player tries to hold a 120-second buffer of 1080p video.
 */
function isLowMemoryDevice(): boolean {
  try {
    const memory = (navigator as any)?.deviceMemory;
    if (typeof memory === 'number' && memory > 0 && memory <= 2) return true;
    const cores = navigator?.hardwareConcurrency;
    if (typeof cores === 'number' && cores > 0 && cores <= 2) return true;
  } catch {
    /* attributes unavailable */
  }
  return false;
}

/**
 * Hls.js configuration tuned for resilient IPTV streaming: generous buffering
 * to ride out origin hiccups, ABR seeded from measured throughput, and latency
 * corrected by playback rate rather than by seeking.
 */
export function createHlsConfig(): Partial<HlsConfig> {
  const constrained = isLowMemoryDevice();

  // Seeding ABR with the persisted estimate means the first fragment of a cold
  // start is chosen from evidence instead of hls.js's blind 500kbps default,
  // which on a fast connection wastes several seconds climbing up the ladder
  // and on a slow one starts too high and stalls immediately.
  const seededEstimate = networkEstimator.getSafeEstimate(0.85);

  return {
    enableWorker: true,
    lowLatencyMode: false,

    backBufferLength: constrained ? 10 : 30,
    maxBufferLength: constrained ? 30 : 60,
    maxMaxBufferLength: constrained ? 60 : 120,
    maxBufferSize: (constrained ? 20 : 60) * 1000 * 1000,
    // Buffer holes larger than this are jumped by hls.js itself; the watchdog's
    // GAP_BRIDGE handles what it misses.
    maxBufferHole: 0.5,

    liveSyncDurationCount: 4,
    liveMaxLatencyDurationCount: 12,
    liveDurationInfinity: true,
    // Corrects live drift by playing imperceptibly faster instead of seeking.
    // A seek is visible and drops the buffer; a 4% rate change is not.
    maxLiveSyncPlaybackRate: 1.04,

    abrEwmaDefaultEstimate: seededEstimate,
    // Asymmetric half-lives: react to a throughput drop within ~3s, but require
    // ~9s of sustained improvement before committing to a higher rendition.
    abrEwmaFastLive: 3.0,
    abrEwmaSlowLive: 9.0,
    abrEwmaFastVoD: 3.0,
    abrEwmaSlowVoD: 9.0,
    // Never commit more than 88% of measured throughput to the video bitrate;
    // the headroom absorbs jitter without draining the buffer.
    abrBandWidthFactor: 0.88,
    abrBandWidthUpFactor: 0.7,
    // Let ABR abandon a fragment that is downloading too slowly to arrive in
    // time, rather than waiting for it and stalling.
    abrMaxWithRealBitrate: true,

    startLevel: -1,
    testBandwidth: true,
    // `progressive` is experimental in hls.js and breaks on origins that mis-report
    // Content-Length — common among IPTV repackagers, and it surfaces as
    // unexplained fragment parsing errors rather than a clean failure.
    progressive: false,

    manifestLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10000,
        maxLoadTimeMs: 20000,
        timeoutRetry: retryPolicy(2, 1000, 8000),
        errorRetry: retryPolicy(3, 1000, 8000)
      }
    },
    playlistLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10000,
        maxLoadTimeMs: 20000,
        timeoutRetry: retryPolicy(2, 1000, 8000),
        errorRetry: retryPolicy(3, 1000, 8000)
      }
    },
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10000,
        // Deliberately shorter than the engine's 12s startup timeout so a
        // wedged fragment surfaces as an error the ladder can act on, instead
        // of being masked by the timeout firing first.
        maxLoadTimeMs: 30000,
        timeoutRetry: retryPolicy(2, 800, 6000),
        errorRetry: retryPolicy(4, 800, 8000)
      }
    },

    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    autoStartLoad: true
  };
}
