import { state } from '../state/store';
import { recordResumeProgress, handleEpisodeEnded } from '../ui/controls';

/**
 * Launches the Android native ExoPlayer activity for a stream this WebView's
 * <video> element cannot decode -- chiefly Matroska. Defensive per this
 * codebase's established AndroidTvNative convention: every call site must
 * tolerate the bridge method being entirely absent (a browser, or an APK built
 * before this existed), which is also why the return value is trusted rather
 * than assumed.
 */
export function playInNativePlayer(
  url: string,
  title: string,
  startPositionSec: number,
  episodeId: string,
  thumbUrl?: string
): boolean {
  const native = (window as any).AndroidTvNative;
  if (!native || typeof native.playInNativePlayer !== 'function') return false;
  try {
    return !!native.playInNativePlayer(url, title, startPositionSec || 0, episodeId || '', thumbUrl || '');
  } catch {
    return false;
  }
}

let registered = false;

/**
 * Wires the native player's progress/completion callbacks into the same
 * resume-tracking and autoplay-next logic in-WebView playback already uses
 * (recordResumeProgress, handleEpisodeEnded in ui/controls.ts), so an episode
 * played natively behaves identically to one played in the <video> element as
 * far as the rest of the app -- resume points, "up next" -- is concerned.
 */
export function registerNativePlayerCallbacks(): void {
  if (registered) return;
  registered = true;

  (window as any).onNativePlayerProgress = (_episodeId: string, positionSec: number, durationSec: number) => {
    recordResumeProgress(positionSec, durationSec);
  };

  (window as any).onNativePlayerEnded = (
    _episodeId: string,
    positionSec: number,
    durationSec: number,
    completed: boolean,
    error: string | null
  ) => {
    const engine = (window as any).engine;

    if (error) {
      engine?.showToast?.(`Playback error: ${error}`, 'error');
      engine?.showOfflineOverlay?.(state.filteredChannels[state.currentChannelIndex] || null);
      return;
    }

    recordResumeProgress(positionSec, durationSec);

    if (completed) {
      handleEpisodeEnded();
    }
  };
}
