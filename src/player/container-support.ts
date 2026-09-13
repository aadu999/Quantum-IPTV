/**
 * What this device can actually decode, decided before anything is loaded.
 *
 * IPTV panels publish whatever their source was, and a large share of that is
 * Matroska. On one real provider sampled for this, 84% of series episodes were
 * `.mkv` -- and no browser, and no Android WebView, can play Matroska in a
 * `<video>` element or through Media Source Extensions. There is no codec
 * negotiation to lose here: the container itself is unsupported, so the request
 * succeeds, bytes arrive, and the element reports a bare "format error".
 *
 * Knowing this up front is what separates "this title is not available in the
 * app" from twenty seconds of spinner followed by a failure.
 */

/**
 * Containers a `<video>` element cannot demux, whatever is inside them.
 *
 * Deliberately a fixed list rather than a canPlayType() probe: browsers return
 * an empty string for anything they are unsure about, which makes a probe
 * indistinguishable from "no opinion", and Chromium reports empty for Matroska
 * even on builds that decode its contents happily in other containers.
 */
const UNPLAYABLE_CONTAINERS = new Set([
  'mkv',
  'avi',
  'wmv',
  'asf',
  'flv',
  'rm',
  'rmvb',
  'divx',
  'ogm',
  'vob',
  'mpg',
  'mpeg'
]);

/**
 * MPEG-TS is deliberately absent from the list above. A `<video>` element cannot
 * play a raw transport stream, but this app runs every live stream through
 * hls.js, which demuxes TS in JavaScript -- and Xtream serves live channels as
 * `.ts`. Treating that extension as unplayable would take the entire live
 * catalogue off the air to fix a video-on-demand problem.
 */

/**
 * Containers that play as a plain progressive download. MPEG-TS is absent: it
 * works for live streams through hls.js, which demuxes it in JavaScript, but not
 * as a standalone file handed to the element.
 */
const PLAYABLE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg']);

/** The file extension of an on-demand URL, lower-cased, or '' if it has none. */
export function containerOf(url: string): string {
  if (!url) return '';
  const match = url.match(/\.([A-Za-z0-9]{2,5})(?:\?|#|$)/);
  return match ? match[1].toLowerCase() : '';
}

/** True when the container cannot be demuxed here, whatever codec is inside. */
export function isUnplayableContainer(ext: string): boolean {
  return UNPLAYABLE_CONTAINERS.has((ext || '').toLowerCase());
}

export function isKnownPlayableContainer(ext: string): boolean {
  return PLAYABLE_CONTAINERS.has((ext || '').toLowerCase());
}

/** True when this URL names a container the player is certain to fail on. */
export function isUnplayableUrl(url: string): boolean {
  return isUnplayableContainer(containerOf(url));
}

/**
 * True when an external player can be handed the stream instead.
 *
 * Only the Android app can do this: a web page has no way to launch another
 * application. Where it is available, an unplayable container is an
 * inconvenience rather than a dead end.
 */
export function canHandOffToExternalPlayer(): boolean {
  const native = (typeof window !== 'undefined' && (window as any).AndroidTvNative) || null;
  return !!native && typeof native.openInExternalPlayer === 'function';
}

/**
 * A short label for an episode card, or '' when the title should play normally.
 */
export function unplayableBadge(url: string): string {
  const ext = containerOf(url);
  if (!isUnplayableContainer(ext)) return '';
  return canHandOffToExternalPlayer() ? `${ext.toUpperCase()} · external` : `${ext.toUpperCase()} · unsupported`;
}

/**
 * A sentence explaining the situation, for the offline overlay and the
 * diagnostic report.
 */
export function describeUnplayable(url: string): string {
  const ext = containerOf(url).toUpperCase() || 'this container';
  if (canHandOffToExternalPlayer()) {
    return `This title is published as ${ext}, which the built-in player cannot decode. It can be opened in an external player such as VLC instead.`;
  }
  return `This title is published as ${ext}, which no browser can play. The provider publishes no alternative container for it, so it cannot be watched in the app — a native player such as VLC will handle it.`;
}
