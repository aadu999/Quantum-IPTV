import { Channel } from '../types';
import { state } from '../state/store';
import { fetchWithProxyFallback } from './proxy';

export interface Programme {
  channelId: string;
  title: string;
  description?: string;
  category?: string;
  /** Epoch milliseconds. */
  start: number;
  stop: number;
}

export interface NowNext {
  now: Programme | null;
  next: Programme | null;
  /** 0..1 through the current programme. */
  progress: number;
}

/**
 * Parses an XMLTV timestamp: `YYYYMMDDHHMMSS` with an optional ` +HHMM` offset.
 *
 * The offset is not optional in practice — omitting it means local time, and
 * guessing wrong shifts the entire guide by hours — so an absent offset is
 * treated as the viewer's own timezone, which is the convention every XMLTV
 * producer assumes when they leave it out.
 */
export function parseXmltvTime(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  const base = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || '0')
  );
  if (!Number.isFinite(base)) return null;

  if (!sign) {
    // No offset declared: re-interpret the wall-clock reading as local time.
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second || '0')
    ).getTime();
  }

  const offsetMs = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60 * 1000;
  return sign === '+' ? base - offsetMs : base + offsetMs;
}

/** Strips decoration so `Asianet News HD` and `asianet-news.in` can be matched. */
function normaliseEpgKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(uk|us|in|ca|au|de|fr|tv)$/i, '')
    .replace(/\b(hd|fhd|uhd|4k|sd|720p|1080p)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export class QuantumEpgGuide {
  /** Programmes by XMLTV channel id, each list sorted by start time. */
  private byChannelId = new Map<string, Programme[]>();
  /** Normalised display names and ids, for channels without a matching tvg-id. */
  private aliasToChannelId = new Map<string, string>();
  private lastLoadedAt = 0;

  get programmeCount(): number {
    let total = 0;
    for (const list of this.byChannelId.values()) total += list.length;
    return total;
  }

  get channelCount(): number {
    return this.byChannelId.size;
  }

  get loadedAt(): number {
    return this.lastLoadedAt;
  }

  ingest(xmlDoc: Document): number {
    this.byChannelId.clear();
    this.aliasToChannelId.clear();

    // <channel> entries carry the display names needed to match playlist rows
    // that have no tvg-id at all, which is most of them on free playlists.
    const channelNodes = xmlDoc.getElementsByTagName('channel');
    for (let i = 0; i < channelNodes.length; i++) {
      const node = channelNodes[i];
      const id = node.getAttribute('id');
      if (!id) continue;
      this.aliasToChannelId.set(normaliseEpgKey(id), id);

      const displayNames = node.getElementsByTagName('display-name');
      for (let j = 0; j < displayNames.length; j++) {
        const name = displayNames[j].textContent;
        if (!name) continue;
        const key = normaliseEpgKey(name);
        // First writer wins: earlier <channel> entries are the canonical ones.
        if (key && !this.aliasToChannelId.has(key)) this.aliasToChannelId.set(key, id);
      }
    }

    const now = Date.now();
    // A guide typically spans a week. Holding all of it costs memory for data
    // nobody scrolls to, so keep yesterday through the next three days.
    const windowStart = now - 12 * 3600 * 1000;
    const windowEnd = now + 72 * 3600 * 1000;

    const programmeNodes = xmlDoc.getElementsByTagName('programme');
    let ingested = 0;

    for (let i = 0; i < programmeNodes.length; i++) {
      const node = programmeNodes[i];
      const channelId = node.getAttribute('channel');
      if (!channelId) continue;

      const start = parseXmltvTime(node.getAttribute('start'));
      if (start === null || start > windowEnd) continue;

      let stop = parseXmltvTime(node.getAttribute('stop'));
      // Missing stop times are common; assume a half-hour slot so the programme
      // still renders and ages out rather than appearing to run forever.
      if (stop === null || stop <= start) stop = start + 30 * 60 * 1000;
      if (stop < windowStart) continue;

      const titleEl = node.getElementsByTagName('title')[0];
      const descEl = node.getElementsByTagName('desc')[0];
      const categoryEl = node.getElementsByTagName('category')[0];

      const programme: Programme = {
        channelId,
        title: titleEl?.textContent?.trim() || 'Programme',
        description: descEl?.textContent?.trim() || undefined,
        category: categoryEl?.textContent?.trim() || undefined,
        start,
        stop
      };

      let list = this.byChannelId.get(channelId);
      if (!list) {
        list = [];
        this.byChannelId.set(channelId, list);
      }
      list.push(programme);
      ingested++;
    }

    for (const list of this.byChannelId.values()) {
      list.sort((a, b) => a.start - b.start);
    }

    this.lastLoadedAt = now;
    return ingested;
  }

  /**
   * Resolves a playlist channel to an XMLTV id. tvg-id is authoritative when
   * present; otherwise the display name is matched after normalisation.
   *
   * The previous matcher used `channelName.includes(epgId)`, which mapped every
   * channel whose name contained a short id as a substring onto the wrong guide
   * — an id like "in" matched hundreds of rows.
   */
  resolveChannelId(channel: Channel): string | null {
    if (channel.tvgId) {
      if (this.byChannelId.has(channel.tvgId)) return channel.tvgId;
      const viaAlias = this.aliasToChannelId.get(normaliseEpgKey(channel.tvgId));
      if (viaAlias) return viaAlias;
    }
    if (channel.name) {
      const viaName = this.aliasToChannelId.get(normaliseEpgKey(channel.name));
      if (viaName) return viaName;
    }
    return null;
  }

  getProgrammes(channel: Channel, limit = 12): Programme[] {
    const channelId = this.resolveChannelId(channel);
    if (!channelId) return [];
    const list = this.byChannelId.get(channelId);
    if (!list) return [];

    const now = Date.now();
    const firstRelevant = list.findIndex(p => p.stop > now);
    if (firstRelevant === -1) return [];
    return list.slice(firstRelevant, firstRelevant + limit);
  }

  getNowNext(channel: Channel): NowNext {
    const upcoming = this.getProgrammes(channel, 2);
    const now = Date.now();

    const current = upcoming.find(p => p.start <= now && p.stop > now) || null;
    const next = upcoming.find(p => p.start > now) || null;

    const progress =
      current && current.stop > current.start
        ? Math.min(1, Math.max(0, (now - current.start) / (current.stop - current.start)))
        : 0;

    return { now: current, next, progress };
  }

  /** Stamps `channel.program` with what is actually on right now. */
  applyToChannels(channels: Channel[]): number {
    let matched = 0;
    for (const channel of channels) {
      const { now } = this.getNowNext(channel);
      if (now) {
        channel.program = now.title;
        matched++;
      }
    }
    return matched;
  }

  hasData(): boolean {
    return this.byChannelId.size > 0;
  }
}

export const epgGuide = new QuantumEpgGuide();

export class QuantumXMLTVParser {
  async loadExternalEPG(xmltvUrl: string): Promise<number> {
    try {
      const xmlText = await fetchWithProxyFallback(xmltvUrl);
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

      // DOMParser reports malformed XML in-band rather than throwing.
      const parseError = xmlDoc.getElementsByTagName('parsererror')[0];
      if (parseError) {
        throw new Error('EPG source is not valid XML');
      }

      const ingested = epgGuide.ingest(xmlDoc);
      if (ingested === 0) {
        throw new Error('EPG contained no programmes in the current window');
      }

      const matched = epgGuide.applyToChannels(state.channels);
      (window as any).filterChannels?.();
      renderEpgTimeline();
      return matched;
    } catch (e) {
      console.error('XMLTV Parser Error:', e);
      throw e;
    }
  }
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Renders the guide for the channel being watched.
 *
 * When no XMLTV source has been loaded this says so plainly rather than showing
 * invented programme titles. The previous implementation always drew four
 * fabricated slots ("Special Program Feature Part 2") over placeholder text,
 * which read as a working guide while carrying no real information.
 */
export function renderEpgTimeline(): void {
  const epgTimelineList = document.getElementById('epg-timeline-list');
  const epgCurrentTime = document.getElementById('epg-current-time');
  if (!epgTimelineList) return;

  const now = Date.now();
  if (epgCurrentTime) epgCurrentTime.textContent = formatClock(now);

  const activeCh = state.filteredChannels[state.currentChannelIndex] || state.channels[0];
  if (!activeCh) {
    epgTimelineList.innerHTML = emptyGuideMarkup('No channel selected.');
    return;
  }

  const programmes = epgGuide.getProgrammes(activeCh, 10);

  if (programmes.length === 0) {
    epgTimelineList.innerHTML = emptyGuideMarkup(
      epgGuide.hasData()
        ? `No guide data published for ${escapeHtml(activeCh.name)}.`
        : 'No EPG source loaded. Add an XMLTV URL under Providers to see live listings.'
    );
    return;
  }

  epgTimelineList.innerHTML = programmes
    .map(programme => {
      const isCurrent = programme.start <= now && programme.stop > now;
      const progress = isCurrent
        ? Math.min(100, Math.max(0, ((now - programme.start) / (programme.stop - programme.start)) * 100))
        : 0;

      const remainingMin = isCurrent ? Math.max(0, Math.round((programme.stop - now) / 60000)) : 0;

      return `
      <div class="p-2.5 rounded-xl border ${
        isCurrent ? 'bg-brand-950/40 border-brand-500/40' : 'bg-slate-950/40 border-slate-800/80'
      } flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-mono text-slate-400">${formatClock(programme.start)} – ${formatClock(programme.stop)}</span>
          <span class="px-1.5 py-0.5 rounded font-bold uppercase tracking-wider text-[9px] ${
            isCurrent ? 'bg-brand-500 text-white' : 'bg-slate-800 text-slate-400'
          }">${isCurrent ? `${remainingMin}m left` : escapeHtml(programme.category || 'Scheduled')}</span>
        </div>
        <div class="text-xs font-semibold ${isCurrent ? 'text-brand-300 font-bold' : 'text-slate-200'}">
          ${escapeHtml(programme.title)}
        </div>
        ${
          isCurrent
            ? `<div class="h-1 w-full rounded-full bg-slate-800 overflow-hidden mt-0.5">
                 <div class="h-full bg-brand-500 rounded-full" style="width:${progress.toFixed(1)}%"></div>
               </div>`
            : ''
        }
        ${
          programme.description
            ? `<div class="text-[10px] text-slate-400 line-clamp-2">${escapeHtml(programme.description)}</div>`
            : ''
        }
      </div>
    `;
    })
    .join('');
}

function emptyGuideMarkup(message: string): string {
  return `
    <div class="p-4 rounded-xl border border-slate-800/80 bg-slate-950/40 text-center">
      <i class="fa-regular fa-calendar-xmark text-slate-600 text-xl mb-2"></i>
      <div class="text-[11px] text-slate-400 leading-relaxed">${message}</div>
    </div>
  `;
}

/**
 * Refreshes the guide roughly once a minute so "now playing" and the progress
 * bar stay honest without re-parsing the source.
 */
let epgRefreshTimer: any = null;
export function startEpgAutoRefresh(): void {
  if (epgRefreshTimer) return;
  epgRefreshTimer = setInterval(() => {
    if (!epgGuide.hasData()) return;
    epgGuide.applyToChannels(state.channels);
    const epgView = document.getElementById('view-epg');
    if (epgView && !epgView.classList.contains('hidden')) {
      renderEpgTimeline();
    }
  }, 60000);
}

/** Retained under the old name for existing callers. */
export function generateSyntheticEpg(): void {
  renderEpgTimeline();
}

export const xmltvParser = new QuantumXMLTVParser();
(window as any).xmltvParser = xmltvParser;
(window as any).epgGuide = epgGuide;
(window as any).renderEpgTimeline = renderEpgTimeline;
(window as any).generateSyntheticEpg = renderEpgTimeline;
