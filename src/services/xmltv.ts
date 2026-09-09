import { state } from '../state/store';
import { fetchWithProxyFallback } from './proxy';

export class QuantumXMLTVParser {
  async loadExternalEPG(xmltvUrl: string): Promise<number> {
    try {
      const xmlText = await fetchWithProxyFallback(xmltvUrl);
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const programmes = xmlDoc.getElementsByTagName('programme');

      let mappedCount = 0;
      for (let i = 0; i < Math.min(programmes.length, 500); i++) {
        const p = programmes[i];
        const chId = p.getAttribute('channel');
        const titleEl = p.getElementsByTagName('title')[0];
        const title = titleEl ? titleEl.textContent || 'Program' : 'Program';

        if (chId) {
          const matchedCh = state.channels.find(
            c =>
              (c.tvgId && c.tvgId.toLowerCase() === chId.toLowerCase()) ||
              c.name.toLowerCase().includes(chId.toLowerCase())
          );
          if (matchedCh) {
            matchedCh.program = title;
            mappedCount++;
          }
        }
      }
      (window as any).filterChannels?.();
      generateSyntheticEpg();
      return mappedCount;
    } catch (e) {
      console.error('XMLTV Parser Error:', e);
      throw e;
    }
  }
}

export function generateSyntheticEpg(): void {
  const epgTimelineList = document.getElementById('epg-timeline-list');
  const epgCurrentTime = document.getElementById('epg-current-time');
  if (!epgTimelineList) return;

  const now = new Date();
  if (epgCurrentTime) {
    epgCurrentTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const timeSlots = [
    { offset: -30, label: 'Started 30m ago', tag: 'Concluded Soon' },
    { offset: 0, label: 'NOW PLAYING', tag: 'LIVE' },
    { offset: 45, label: 'Up Next (45m)', tag: 'Scheduled' },
    { offset: 120, label: 'Evening Prime Time', tag: 'Prime' }
  ];

  const activeCh = state.filteredChannels[state.currentChannelIndex] || state.channels[0];

  epgTimelineList.innerHTML = timeSlots
    .map((slot, i) => {
      const slotDate = new Date(now.getTime() + slot.offset * 60000);
      const timeStr = slotDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const isCurrent = slot.offset === 0;

      return `
      <div class="p-2.5 rounded-xl border ${
        isCurrent ? 'bg-brand-950/40 border-brand-500/40' : 'bg-slate-950/40 border-slate-800/80'
      } flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-mono text-slate-400">${timeStr}</span>
          <span class="px-1.5 py-0.5 rounded font-bold uppercase tracking-wider text-[9px] ${
            isCurrent ? 'bg-brand-500 text-white animate-pulse' : 'bg-slate-800 text-slate-400'
          }">${slot.tag}</span>
        </div>
        <div class="text-xs font-semibold ${isCurrent ? 'text-brand-300 font-bold' : 'text-slate-200'}">
          ${isCurrent ? (activeCh?.program || 'Live Broadcast Edition') : `Special Program Feature Part ${i + 1}`}
        </div>
        <div class="text-[10px] text-slate-400 line-clamp-1">
          High definition satellite broadcast covering regional breaking developments and prime panel coverage.
        </div>
      </div>
    `;
    })
    .join('');
}

export const xmltvParser = new QuantumXMLTVParser();
(window as any).xmltvParser = xmltvParser;
(window as any).generateSyntheticEpg = generateSyntheticEpg;
