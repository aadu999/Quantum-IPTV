import { Channel } from '../types';
import { state, FALLBACK_LOGO, handleLogoError, generateChannelId } from '../state/store';
import { QuantumSessionStore } from '../state/session';
import { userProfile } from '../state/user-profile';
import { circuitBreaker } from '../player/circuit-breaker';
import { broadcastTVState, sendRemoteCmd } from '../services/remote';
import { xtreamConnector, getXtreamCredentials } from '../services/xtream';
import { inferChannelLanguage } from '../services/m3u';
import { QuantumStreamEngine } from '../player/engine';
import { sessionManager } from '../core/session';
import { channelReliability } from '../state/channel-health';
import { seriesContext } from '../state/series-context';

let engineInstance: QuantumStreamEngine | null = null;

export function setChannelEngineInstance(engine: QuantumStreamEngine): void {
  engineInstance = engine;
}

export function playChannel(index: number, options: { directPlay?: boolean } = {}): void {
  if (state.isRemoteClient) return;
  if (index < 0 || index >= state.filteredChannels.length) return;
  state.currentChannelIndex = index;
  const channel = state.filteredChannels[index];
  if (!channel) return;

  const isSeries =
    channel.type === 'series' ||
    Boolean(channel.seriesId) ||
    (Boolean(channel.url) && channel.url.includes('/series/'));

  const isVod =
    channel.type === 'vod' ||
    Boolean(channel.vodId) ||
    (Boolean(channel.url) && channel.url.includes('/movie/'));

  // Selecting series or movie on TV list displays its info dialogue box,
  // UNLESS directPlay is requested (e.g. from Remote or when clicking Play on an episode/movie)
  if (!options?.directPlay) {
    if (isSeries) {
      (window as any).openSeriesExplorer?.(channel);
      renderChannelList();
      renderQuickChannelStrip();
      return;
    }

    if (isVod) {
      (window as any).openMovieExplorer?.(channel);
      renderChannelList();
      renderQuickChannelStrip();
      return;
    }
  }

  (window as any).closeModals?.();
  const currentChName = document.getElementById('current-ch-name');
  const currentChLogo = document.getElementById('current-ch-logo') as HTMLImageElement | null;
  const currentChEpg = document.getElementById('current-ch-epg');
  const hudZtf = document.getElementById('hud-ztf');
  if (hudZtf) hudZtf.textContent = '...';

  if (currentChName) currentChName.textContent = channel.name;
  if (currentChLogo) currentChLogo.src = channel.logo || FALLBACK_LOGO;
  if (currentChEpg) currentChEpg.textContent = channel.program || channel.group || 'Live Stream';

  sessionManager.startSession(channel.id, channel.name, Date.now());

  userProfile.recordWatchEvent(channel, 5);
  QuantumSessionStore.saveSession({
    lastChannelIndex: index,
    lastChannelId: channel.id,
    lastChannelUrl: channel.url
  });

  engineInstance?.load(channel.url);
  renderChannelList();
  renderQuickChannelStrip();
  broadcastTVState();
  try {
    (window as any).adjustMobileVideoStage?.();
  } catch (e) {}
}

export function tuneToChannel(target: Partial<Channel>): void {
  if (!target || state.isRemoteClient) return;

  (window as any).closeModals?.();

  let idx = state.channels.findIndex(
    ch =>
      (target.id && ch.id === target.id) ||
      (target.url && ch.url === target.url) ||
      (target.name && ch.name.toLowerCase() === target.name.toLowerCase())
  );

  if (idx === -1 && target.url) {
    const newCh: Channel = {
      id: target.id || generateChannelId(target.name || 'Channel', target.url),
      name: target.name || 'Stream Channel',
      url: target.url,
      logo: target.logo || '',
      group: target.group || 'Live',
      country: target.country || 'TV',
      program: target.program || 'Live Satellite Broadcast',
      type: target.type || 'live'
    };
    state.channels.push(newCh);
    state.filteredChannels = [...state.channels];
    idx = state.channels.length - 1;
  }

  if (idx !== -1) {
    state.filteredChannels = [...state.channels];
    playChannel(idx, { directPlay: true });
  }
}

export function toggleFavorite(channelId: string, evt?: Event): void {
  if (evt) evt.stopPropagation();
  const idx = state.favorites.indexOf(channelId);
  let isNowFav = false;
  if (idx > -1) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.push(channelId);
    isNowFav = true;
  }
  localStorage.setItem('quantum_iptv_favs', JSON.stringify(state.favorites));
  updateFavoritesUI();
  renderChannelList();
  broadcastTVState();

  const ch = state.channels.find(c => c.id === channelId);
  (window as any).showTvFavoriteToast?.(isNowFav, ch?.name || 'Channel');
}

export function updateFavoritesUI(): void {
  const favCountBadge = document.getElementById('fav-count-badge');
  const favPillCount = document.getElementById('fav-pill-count');
  const favoritesListContainer = document.getElementById('favorites-list-container');
  const favoritesEmptyMsg = document.getElementById('favorites-empty-msg');

  if (favCountBadge) favCountBadge.textContent = String(state.favorites.length);
  if (favPillCount) favPillCount.textContent = String(state.favorites.length);
  if (!favoritesListContainer) return;

  const favChannels = state.channels.filter(ch => state.favorites.includes(ch.id));
  if (favChannels.length === 0) {
    if (favoritesEmptyMsg) favoritesEmptyMsg.classList.remove('hidden');
    favoritesListContainer.innerHTML = '';
  } else {
    if (favoritesEmptyMsg) favoritesEmptyMsg.classList.add('hidden');
    favoritesListContainer.innerHTML = favChannels
      .map(
        ch => {
          const globalIdx = state.channels.findIndex(c => c.id === ch.id);
          return `
        <div data-channel-id="${ch.id}" tabindex="0" onclick="window.playChannel(${globalIdx >= 0 ? globalIdx : 0})" class="p-2.5 flex items-center justify-between hover:bg-slate-800/80 cursor-pointer transition rounded-xl border border-transparent focus:border-brand-500 focus:bg-slate-800/90 mb-1">
          <div class="flex items-center gap-2.5 overflow-hidden">
            <img src="${ch.logo || FALLBACK_LOGO}" referrerpolicy="no-referrer" onerror="handleLogoError(this)" class="w-6 h-6 rounded object-contain bg-slate-800 p-0.5 border border-slate-700 shrink-0">
            <div class="overflow-hidden">
              <div class="text-xs font-semibold text-white truncate">${ch.name}</div>
              <div class="text-[10px] text-slate-400 truncate">${ch.group || 'Live'}</div>
            </div>
          </div>
          <button onclick="window.toggleFavorite('${ch.id}', event)" class="text-amber-400 p-1 text-xs hover:scale-110 transition focus:outline-none" title="Remove Favorite">
            <i class="fa-solid fa-star"></i>
          </button>
        </div>
      `;
        }
      )
      .join('');
  }
}

export function filterContentType(type: string): void {
  (state as any).contentTypeFilter = type;
  const pills = ['all', 'favs', 'recommended', 'live', 'vod', 'series', 'catchup'];
  pills.forEach(p => {
    const btn = document.getElementById(`pill-type-${p}`);
    if (btn) {
      if (p === type.toLowerCase() || (type === 'ALL' && p === 'all')) {
        btn.className = 'px-2 py-0.5 rounded-full bg-brand-600 text-white font-semibold whitespace-nowrap transition flex items-center gap-1';
      } else {
        btn.className =
          'px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 hover:text-white font-medium whitespace-nowrap transition flex items-center gap-1';
      }
    }
  });
  filterChannels();
}


/**
 * Stable sort placing working channels first, then flaky, then believed-dead.
 * Array.prototype.sort is stable in every engine this targets, but the decorate
 * step makes the tie-break explicit rather than relying on that.
 */
function stableSortByReliability(list: Channel[]): Channel[] {
  let needsReorder = false;
  const decorated = list.map((ch, index) => {
    const tier = channelReliability.getTier(ch);
    if (tier !== 0) needsReorder = true;
    return { ch, tier, index };
  });

  // Nothing has a failure record: skip the sort entirely, which matters because
  // this runs on every search keystroke over the whole catalogue.
  if (!needsReorder) return list;

  decorated.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return decorated.map(d => d.ch);
}

export function filterChannels(): void {
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const clearBtn = document.getElementById('search-clear-btn');
  const regionFilter = document.getElementById('region-filter') as HTMLSelectElement | null;
  const categoryFilter = document.getElementById('category-filter') as HTMLSelectElement | null;
  const languageFilter = document.getElementById('language-filter') as HTMLSelectElement | null;

  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const region = regionFilter ? regionFilter.value : 'ALL';
  const category = categoryFilter ? categoryFilter.value : 'ALL';
  const language = languageFilter ? languageFilter.value : 'ALL';
  const typeFilter = (state as any).contentTypeFilter || 'ALL';

  if (clearBtn) {
    clearBtn.classList.toggle('hidden', query.length === 0);
  }

  state.filteredChannels = state.channels.filter(ch => {
    if ((state as any).hideOfflineFeeds && state.offlineChannels && state.offlineChannels.has(ch.id)) {
      return false;
    }

    const matchesType =
      typeFilter === 'ALL' ||
      typeFilter === 'recommended' ||
      (typeFilter === 'favs' && state.favorites.includes(ch.id)) ||
      (typeFilter === 'live' && (!ch.type || ch.type === 'live')) ||
      (typeFilter === 'vod' && ch.type === 'vod') ||
      (typeFilter === 'series' && ch.type === 'series') ||
      (typeFilter === 'catchup' && ((ch as any).catchup || (ch as any).catchupDays));

    const matchesQuery =
      !query ||
      (ch.name && ch.name.toLowerCase().includes(query)) ||
      (ch.group && ch.group.toLowerCase().includes(query)) ||
      (ch.program && ch.program.toLowerCase().includes(query)) ||
      (ch.country && ch.country.toLowerCase().includes(query)) ||
      (ch.language && ch.language.toLowerCase().includes(query));

    const matchesRegion = region === 'ALL' || (ch.country && ch.country.toUpperCase() === region);
    const matchesCategory =
      category === 'ALL' || (ch.group && ch.group.toLowerCase().includes(category.toLowerCase()));
    const matchesLanguage =
      language === 'ALL' ||
      (ch.language && ch.language.toLowerCase() === language.toLowerCase()) ||
      (ch.group && ch.group.toLowerCase().includes(language.toLowerCase())) ||
      (ch.name && ch.name.toLowerCase().includes(language.toLowerCase()));

    return matchesType && matchesQuery && matchesRegion && matchesCategory && matchesLanguage;
  });

  // Demote channels that have repeatedly failed to play.
  //
  // Large playlists carry a lot of permanently dead entries, and interleaved
  // with working ones the viewer finds them one timeout at a time. Sorting is
  // stable, so the provider's own ordering is preserved within each tier and
  // untried channels are never demoted -- only ones with a real failure record.
  state.filteredChannels = stableSortByReliability(state.filteredChannels);

  (state as any).tvLimit = 80;
  renderChannelList();

  // Scroll to top of list when searching
  if (query.length > 0) {
    const viewChannels = document.getElementById('view-channels');
    if (viewChannels) viewChannels.scrollTop = 0;
  }
}

export function loadMoreTvChannels(): void {
  const currentLimit = (state as any).tvLimit || 80;
  if (currentLimit >= state.filteredChannels.length) return;
  const viewEl = document.getElementById('view-channels');
  const currentScroll = viewEl ? viewEl.scrollTop : 0;
  (state as any).tvLimit = currentLimit + 80;
  renderChannelList();
  if (viewEl) viewEl.scrollTop = currentScroll;
}

export function renderChannelList(): void {
  const viewChannels = document.getElementById('view-channels');
  if (!viewChannels) return;

  const counterEl = document.getElementById('tv-channel-counter');
  if (counterEl) {
    counterEl.textContent = `${state.filteredChannels.length.toLocaleString()} channels`;
  }

  if (state.filteredChannels.length === 0) {
    viewChannels.innerHTML = `
      <div class="p-6 text-center text-xs text-slate-500">
        <i class="fa-solid fa-tv text-xl mb-2 text-slate-600 block"></i>
        No channels found matching query.<br>
        <span class="text-[10px] text-slate-400">Try clearing filters or search terms.</span>
      </div>`;
    return;
  }

  const displayChannels = state.filteredChannels.slice(0, (state as any).tvLimit || 80);

  let html = displayChannels
    .map((ch, idx) => {
      const isActive = idx === state.currentChannelIndex;
      const isFav = state.favorites.includes(ch.id);
      const isOffline = state.offlineChannels ? state.offlineChannels.has(ch.id) : false;
      // Persisted verdict from previous tune attempts, so a channel known to be
      // dead is labelled before the viewer wastes a timeout discovering it.
      const tier = channelReliability.getTier(ch);
      const reliabilityNote = channelReliability.describe(ch);
      const sourceCount = ch.sources ? ch.sources.length : 1;

      return `
      <div data-channel-id="${ch.id}" tabindex="0" onclick="window.playChannel(${idx})" class="p-2.5 flex items-center justify-between hover:bg-slate-800/80 cursor-pointer transition ${
        isActive ? 'bg-brand-950/60 border-l-4 border-brand-500 pl-2' : ''
      } ${tier === 2 && !isActive ? 'opacity-55' : ''}">
        <div class="flex items-center gap-2.5 overflow-hidden">
          <img src="${ch.logo || FALLBACK_LOGO}" referrerpolicy="no-referrer" onerror="handleLogoError(this)" class="w-7 h-7 rounded object-contain bg-slate-800 p-0.5 border border-slate-700 shrink-0">
          <div class="overflow-hidden">
            <div class="text-xs font-semibold ${isActive ? 'text-brand-400' : 'text-slate-200'} truncate flex items-center gap-1.5">
              <span>${ch.name}</span>
              ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-brand-400 animate-ping"></span>' : ''}
              ${
                sourceCount > 1
                  ? `<span class="px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-mono">${sourceCount} Streams</span>`
                  : ''
              }
              ${
                isOffline || tier === 2
                  ? `<span title="${escapeAttr(reliabilityNote || 'Offline')}" class="text-[9px] px-1 py-0.2 rounded bg-rose-950/80 text-rose-400 border border-rose-800/50 font-mono"><i class="fa-solid fa-circle-xmark mr-0.5 text-[8px]"></i>Offline</span>`
                  : tier === 1
                  ? `<span title="${escapeAttr(reliabilityNote || 'Unreliable')}" class="text-[9px] px-1 py-0.2 rounded bg-amber-950/70 text-amber-400 border border-amber-800/50 font-mono"><i class="fa-solid fa-triangle-exclamation mr-0.5 text-[8px]"></i>Flaky</span>`
                  : ''
              }
            </div>
            <div class="text-[10px] text-slate-400 truncate flex items-center gap-1.5">
              <span class="px-1 py-0.2 rounded bg-slate-800 text-[9px] text-slate-400 font-mono">${ch.country || 'TV'}</span>
              ${
                ch.language
                  ? `<span class="px-1 py-0.2 rounded bg-brand-950/80 text-brand-300 border border-brand-800/50 text-[9px] font-mono">${ch.language}</span>`
                  : ''
              }
              <span>${ch.program || 'Live broadcast'}</span>
            </div>
          </div>
        </div>
        <button tabindex="-1" onclick="window.toggleFavorite('${ch.id}', event)" class="channel-fav-btn p-1.5 text-xs ${
          isFav ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
        } transition hover:scale-110 shrink-0" title="Add to Favorite (Right Arrow)">
          <i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-star pointer-events-none"></i>
        </button>
      </div>
    `;
    })
    .join('');

  if (((state as any).tvLimit || 80) < state.filteredChannels.length) {
    html += `
      <div class="p-3 text-center text-[11px] text-slate-500 bg-slate-950/30 flex items-center justify-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse"></span>
        <span>Scroll for more (${displayChannels.length} of ${state.filteredChannels.length.toLocaleString()})</span>
      </div>
    `;
  }

  viewChannels.innerHTML = html;
  renderQuickChannelStrip();
}

export function renderQuickChannelStrip(): void {
  const strip = document.getElementById('tv-quick-channel-strip');
  if (!strip || state.isRemoteClient) return;

  // Remember which card had D-pad focus: the strip is re-rendered wholesale on
  // every tune, which destroys the focused node and used to drop the viewer
  // back to whatever focusFirstInteractiveElement() picked.
  const focusedKey = strip.querySelector('.tv-focused')?.getAttribute('data-focus-key') || null;

  const html = seriesContext.current ? buildEpisodeStrip() : buildChannelStrip();
  if (html === null) {
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = html;
  attachStripDelegation();

  const restored = focusedKey
    ? (strip.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`) as HTMLElement | null)
    : null;
  if (restored) {
    restored.classList.add('tv-focused');
    restored.focus({ preventScroll: true });
  }

  const activeCard = strip.querySelector('[data-strip-active="true"]') as HTMLElement | null;
  if (activeCard) {
    activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

/**
 * While a series episode is playing the strip lists that series' episodes
 * rather than unrelated live channels, so left/right steps through the season
 * instead of jumping out of the programme the viewer is watching.
 */
function buildEpisodeStrip(): string | null {
  const ctx = seriesContext.current;
  if (!ctx || ctx.episodes.length === 0) return null;

  return ctx.episodes
    .map((ep, idx) => {
      const isActive = idx === ctx.index;
      const resume = seriesContext.getResume(ep.id);
      const pct = resume && resume.durationSec > 0
        ? Math.min(100, Math.round((resume.positionSec / resume.durationSec) * 100))
        : 0;
      const epLabel = `S${String(ep.season).padStart(2, '0')}E${String(ep.episodeNum).padStart(2, '0')}`;

      return `
        <div data-quick-episode-idx="${idx}" data-focus-key="ep:${escapeAttr(ep.id)}" ${isActive ? 'data-strip-active="true"' : ''} tabindex="0" class="shrink-0 w-48 rounded-xl overflow-hidden cursor-pointer transition-all duration-150 backdrop-blur-md ${
          isActive
            ? 'bg-brand-600/30 border-2 border-brand-400 shadow-[0_0_15px_rgba(99,102,241,0.6)] scale-[1.03]'
            : 'bg-slate-900/80 border border-slate-700/60 hover:bg-slate-800/80 hover:border-slate-600'
        }">
          <div class="relative w-full aspect-video bg-slate-950">
            ${ep.thumb ? `<img src="${escapeAttr(ep.thumb)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.classList.add('hidden')" class="w-full h-full object-cover">` : ''}
            <span class="absolute top-1 left-1 px-1 py-0.2 rounded bg-black/75 text-[8px] font-mono font-bold ${isActive ? 'text-brand-300' : 'text-slate-300'}">${epLabel}</span>
            ${pct > 0 ? `<div class="absolute bottom-0 left-0 right-0 h-0.5 bg-black/60"><div class="h-full bg-brand-500" style="width:${pct}%"></div></div>` : ''}
          </div>
          <div class="px-2 py-1.5 text-left">
            <div class="text-[11px] font-semibold text-white truncate leading-tight">${escapeHtml(ep.title)}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function buildChannelStrip(): string | null {
  if (state.filteredChannels.length === 0) return null;

  const total = state.filteredChannels.length;
  const start = Math.max(0, Math.min(total - 35, state.currentChannelIndex - 8));
  const slice = state.filteredChannels.slice(start, start + 35);

  return slice
    .map((ch, relativeIdx) => {
      const actualIndex = start + relativeIdx;
      const isActive = actualIndex === state.currentChannelIndex;
      const isFav = state.favorites.includes(ch.id);
      const tier = channelReliability.getTier(ch);

      return `
        <div data-quick-channel-idx="${actualIndex}" data-focus-key="ch:${escapeAttr(ch.id)}" ${isActive ? 'data-strip-active="true"' : ''} tabindex="0" class="shrink-0 w-44 p-2 rounded-xl flex items-center gap-2.5 cursor-pointer transition-all duration-150 backdrop-blur-md ${
          isActive
            ? 'bg-brand-600/30 border-2 border-brand-400 shadow-[0_0_15px_rgba(99,102,241,0.6)] scale-[1.03]'
            : 'bg-slate-900/80 border border-slate-700/60 hover:bg-slate-800/80 hover:border-slate-600'
        } ${tier === 2 && !isActive ? 'opacity-55' : ''}">
          <img src="${escapeAttr(ch.logo || FALLBACK_LOGO)}" referrerpolicy="no-referrer" onerror="handleLogoError(this)" class="w-8 h-8 rounded-lg object-contain bg-slate-950 p-0.5 border border-slate-700 shrink-0">
          <div class="overflow-hidden flex-1 text-left">
            <div class="flex items-center justify-between">
              <span class="text-[9px] font-mono font-bold ${isActive ? 'text-brand-300' : 'text-slate-400'}">CH ${actualIndex + 1}</span>
              <span class="flex items-center gap-1">
                ${tier === 2 ? '<i class="fa-solid fa-circle-xmark text-[8px] text-rose-500"></i>' : tier === 1 ? '<i class="fa-solid fa-triangle-exclamation text-[8px] text-amber-500"></i>' : ''}
                ${isFav ? '<i class="fa-solid fa-star text-[8px] text-amber-400"></i>' : ''}
              </span>
            </div>
            <div class="text-xs font-semibold text-white truncate leading-tight mt-0.5">${escapeHtml(ch.name)}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

/** One delegated handler for both strip modes. */
function attachStripDelegation(): void {
  const strip = document.getElementById('tv-quick-channel-strip');
  if (!strip || strip.dataset.hasStripDelegation) return;
  strip.dataset.hasStripDelegation = 'true';

  strip.addEventListener('click', event => {
    const card = (event.target as HTMLElement)?.closest('[data-quick-channel-idx], [data-quick-episode-idx]') as HTMLElement | null;
    if (!card) return;

    const epIdx = card.getAttribute('data-quick-episode-idx');
    if (epIdx !== null) {
      (window as any).playEpisodeAt?.(Number(epIdx));
      return;
    }
    const chIdx = card.getAttribute('data-quick-channel-idx');
    if (chIdx !== null) playChannel(Number(chIdx), { directPlay: true });
  });
}

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function attachRemoteListDelegation(container: HTMLElement): void {
  if (container.dataset.hasClickDelegation) return;
  container.dataset.hasClickDelegation = 'true';

  container.addEventListener('click', event => {
    const target = (event.target as HTMLElement)?.closest('[data-remote-action]') as HTMLElement | null;
    if (!target) return;

    const id = target.getAttribute('data-remote-id');
    const action = target.getAttribute('data-remote-action');
    if (!id || !action) return;

    const channel = state.channels.find(c => c.id === id);
    if (!channel) return;

    event.stopPropagation();

    if (action === 'fav') {
      (window as any).toggleRemoteFav?.(id, event);
      return;
    }
    if (action === 'movie') {
      (window as any).openRemoteMovieExplorerById?.(id);
      return;
    }
    if (action === 'series') {
      (window as any).openRemoteSeriesExplorerById?.(id);
      return;
    }

    sendRemoteCmd('TUNE_CHANNEL', {
      id: channel.id,
      url: channel.url,
      name: channel.name,
      logo: channel.logo,
      program: channel.program,
      type: channel.type || 'live'
    });
  });
}

export function renderRemoteFilterBar(): void {
  const bar = document.getElementById('remote-filter-bar');
  if (!bar) return;

  const languages = new Set<string>();
  const groups = new Set<string>();
  for (const ch of state.channels) {
    if (ch.language) languages.add(ch.language);
    if (ch.group) groups.add(ch.group);
  }

  const filters = state.remoteFilters;
  const sortedLanguages = [...languages].sort((a, b) => a.localeCompare(b));
  // Groups can run to hundreds on a large Xtream account; cap the dropdown so it
  // stays usable on a phone, and keep the active one visible even if truncated.
  const sortedGroups = [...groups].sort((a, b) => a.localeCompare(b)).slice(0, 200);
  if (filters.group !== 'ALL' && !sortedGroups.includes(filters.group)) {
    sortedGroups.unshift(filters.group);
  }

  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${escapeAttr(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  bar.innerHTML = `
    <select id="remote-filter-language" class="bg-slate-900 text-slate-200 text-[11px] rounded-lg px-2 py-1.5 border border-slate-800 focus:outline-none focus:border-brand-500 min-w-0 flex-1">
      ${option('ALL', `All languages (${sortedLanguages.length})`, filters.language === 'ALL')}
      ${sortedLanguages.map(l => option(l, l, filters.language === l)).join('')}
    </select>
    <select id="remote-filter-group" class="bg-slate-900 text-slate-200 text-[11px] rounded-lg px-2 py-1.5 border border-slate-800 focus:outline-none focus:border-brand-500 min-w-0 flex-1">
      ${option('ALL', 'All groups', filters.group === 'ALL')}
      ${sortedGroups.map(g => option(g, g, filters.group === g)).join('')}
    </select>
    <select id="remote-filter-sort" class="bg-slate-900 text-slate-200 text-[11px] rounded-lg px-2 py-1.5 border border-slate-800 focus:outline-none focus:border-brand-500 shrink-0">
      ${option('default', 'Playlist order', filters.sort === 'default')}
      ${option('name', 'A–Z', filters.sort === 'name')}
      ${option('group', 'By group', filters.sort === 'group')}
    </select>
    <button id="remote-filter-favs" title="Favourites only" class="px-2.5 py-1.5 rounded-lg border text-[11px] shrink-0 transition ${
      filters.favouritesOnly
        ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
        : 'bg-slate-900 border-slate-800 text-slate-400'
    }">
      <i class="${filters.favouritesOnly ? 'fa-solid' : 'fa-regular'} fa-star pointer-events-none"></i>
    </button>
  `;

  bar.querySelector('#remote-filter-language')?.addEventListener('change', e => {
    state.remoteFilters.language = (e.target as HTMLSelectElement).value;
    state.remoteLimit = 60;
    renderRemoteChannelsList();
  });
  bar.querySelector('#remote-filter-group')?.addEventListener('change', e => {
    state.remoteFilters.group = (e.target as HTMLSelectElement).value;
    state.remoteLimit = 60;
    renderRemoteChannelsList();
  });
  bar.querySelector('#remote-filter-sort')?.addEventListener('change', e => {
    state.remoteFilters.sort = (e.target as HTMLSelectElement).value as typeof state.remoteFilters.sort;
    renderRemoteChannelsList();
  });
  bar.querySelector('#remote-filter-favs')?.addEventListener('click', () => {
    state.remoteFilters.favouritesOnly = !state.remoteFilters.favouritesOnly;
    state.remoteLimit = 60;
    renderRemoteChannelsList();
  });
}

export function resetRemoteFilters(): void {
  state.remoteFilters = { language: 'ALL', group: 'ALL', favouritesOnly: false, sort: 'default' };
  state.remoteActiveCategory = 'ALL';
  state.remoteLimit = 60;
  const searchInput = document.getElementById('remote-search-input') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  renderRemoteChannelsList();
}

export function updateLanguageDropdown(): void {
  const languageFilter = document.getElementById('language-filter') as HTMLSelectElement | null;
  if (!languageFilter) return;

  const currentVal = languageFilter.value || 'Malayalam';

  const standardLangs = ['Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Kannada', 'English'];

  const langCounts: Record<string, number> = {};
  state.channels.forEach(ch => {
    if (!ch.language) {
      const inf = inferChannelLanguage(ch.name, ch.tvgId, ch.group);
      if (inf) ch.language = inf;
    }
    if (ch.language) {
      langCounts[ch.language] = (langCounts[ch.language] || 0) + 1;
    }
  });

  // Ensure popular languages are present if any channel matches by group or name
  standardLangs.forEach(sl => {
    if (!langCounts[sl]) {
      const matches = state.channels.filter(
        ch =>
          (ch.group && ch.group.toLowerCase().includes(sl.toLowerCase())) ||
          (ch.name && ch.name.toLowerCase().includes(sl.toLowerCase()))
      ).length;
      if (matches > 0) langCounts[sl] = matches;
    }
  });

  const sortedLangs = Object.keys(langCounts).sort((a, b) => langCounts[b] - langCounts[a]);

  let html = `<option value="ALL">All Languages (${state.channels.length.toLocaleString()})</option>`;
  sortedLangs.forEach(lang => {
    const isSelected = lang.toLowerCase() === currentVal.toLowerCase() ? ' selected' : '';
    html += `<option value="${lang}"${isSelected}>${lang} (${langCounts[lang].toLocaleString()})</option>`;
  });
  languageFilter.innerHTML = html;

  if (currentVal) {
    const matchedOpt = Array.from(languageFilter.options).find(
      o => o.value.toLowerCase() === currentVal.toLowerCase()
    );
    if (matchedOpt) {
      languageFilter.value = matchedOpt.value;
    }
  }

  const labelEl = document.getElementById('label-language-filter');
  if (labelEl) {
    const opt = languageFilter.options[languageFilter.selectedIndex];
    labelEl.textContent = opt ? opt.text : (currentVal || 'Malayalam');
  }
}

export function renderRemoteChannelsList(): void {
  const container = document.getElementById('remote-channels-render');
  const loadMoreBtn = document.getElementById('remote-load-more');
  if (!container) return;

  const searchInput = document.getElementById('remote-search-input') as HTMLInputElement | null;
  const clearBtn = document.getElementById('remote-search-clear');
  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const cat = state.remoteActiveCategory || 'ALL';

  if (clearBtn) {
    clearBtn.classList.toggle('hidden', query.length === 0);
  }

  const list = state.channels.filter(ch => {
    const matchesSearch =
      !query ||
      (ch.name && ch.name.toLowerCase().includes(query)) ||
      (ch.country && ch.country.toLowerCase().includes(query)) ||
      (ch.group && ch.group.toLowerCase().includes(query)) ||
      (ch.program && ch.program.toLowerCase().includes(query));

    let matchesCat = false;
    if (cat === 'ALL') {
      matchesCat = true;
    } else if (cat === 'MOVIES') {
      matchesCat =
        ch.type === 'vod' ||
        Boolean(ch.vodId) ||
        (ch.group && /^vod/i.test(ch.group)) ||
        Boolean(ch.url && ch.url.includes('/movie/'));
    } else if (cat === 'SERIES') {
      matchesCat =
        ch.type === 'series' ||
        Boolean(ch.seriesId) ||
        (ch.group && /series|shows|seasons/i.test(ch.group)) ||
        Boolean(ch.url && ch.url.includes('/series/'));
    } else if (cat === 'LIVE') {
      matchesCat =
        ch.type !== 'vod' &&
        ch.type !== 'series' &&
        (!ch.url || (!ch.url.includes('/movie/') && !ch.url.includes('/series/')));
    } else if (cat === 'IN') {
      matchesCat = ch.country === 'IN' || Boolean(ch.name && /asianet|india|malayalam|kannada|hindi|tamil/i.test(ch.name));
    } else {
      matchesCat = Boolean(ch.group && ch.group.toLowerCase().includes(cat.toLowerCase()));
    }

    const filters = state.remoteFilters;
    const matchesLanguage = filters.language === 'ALL' || ch.language === filters.language;
    const matchesGroup = filters.group === 'ALL' || ch.group === filters.group;
    const matchesFavourite = !filters.favouritesOnly || state.favorites.includes(ch.id);

    return matchesSearch && matchesCat && matchesLanguage && matchesGroup && matchesFavourite;
  });

  const sort = state.remoteFilters.sort;
  if (sort === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'group') {
    list.sort(
      (a, b) => (a.group || '').localeCompare(b.group || '') || (a.name || '').localeCompare(b.name || '')
    );
  }

  renderRemoteFilterBar();

  if (list.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-xs text-slate-500 flex flex-col items-center gap-2">
        <i class="fa-solid fa-tv text-2xl text-slate-600"></i>
        <span>No streams match the current filters.</span>
        <button onclick="window.resetRemoteFilters()" class="mt-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-[10px] text-slate-300">Clear filters</button>
      </div>`;
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }

  const sliceLimit = state.remoteLimit || 60;
  const curPlayingId = document.getElementById('remote-now-channel')?.getAttribute('data-id');
  const displayChannels = list.slice(0, sliceLimit);
  const hasMore = list.length > sliceLimit;

  let html = displayChannels
    .map(ch => {
      const isFav = state.favorites.includes(ch.id);
      const isPlayingOnTv = curPlayingId && ch.id === curPlayingId;

      // Channel metadata comes from third-party playlists. It used to be spliced
      // into inline onclick strings with only single quotes escaped, so a name
      // containing a double quote broke out of the attribute and a crafted
      // playlist could execute script in the remote. Identity now travels in a
      // data attribute and the click is handled by delegation below.
      let badgeTag = ch.country || 'TV';
      let action = 'tune';

      if (ch.type === 'vod' || (ch.url && ch.url.includes('/movie/'))) {
        badgeTag = '🎬 VOD Movie';
        action = 'movie';
      } else if (ch.type === 'series' || ch.seriesId || (ch.url && ch.url.includes('/series/'))) {
        badgeTag = '🍿 TV Series';
        action = 'series';
      }

      return `
      <div data-remote-id="${escapeAttr(ch.id)}" data-remote-action="${action}" class="p-2.5 rounded-xl flex items-center justify-between active:bg-slate-800 transition cursor-pointer ${
        isPlayingOnTv
          ? 'bg-brand-950/70 border-2 border-brand-500 shadow-[0_0_15px_rgba(99,102,241,0.5)]'
          : 'bg-slate-900 border border-slate-800/80 hover:bg-slate-850'
      }">
        <div class="flex items-center gap-3 overflow-hidden">
          <img src="${escapeAttr(ch.logo || FALLBACK_LOGO)}" referrerpolicy="no-referrer" onerror="handleLogoError(this)" class="w-8 h-8 rounded object-contain bg-slate-800 p-0.5 border border-slate-700 shrink-0">
          <div class="text-left overflow-hidden">
            <div class="text-xs font-semibold ${isPlayingOnTv ? 'text-brand-300' : 'text-white'} truncate flex items-center gap-1.5">
              <span>${escapeHtml(ch.name || 'Stream Channel')}</span>
              ${isPlayingOnTv ? '<span class="px-1.5 py-0.2 rounded bg-brand-500/30 text-brand-300 text-[8px] font-bold uppercase tracking-wider animate-pulse">ON TV</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400">${escapeHtml(badgeTag)} · ${escapeHtml(ch.group || 'Stream')}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button data-remote-id="${escapeAttr(ch.id)}" data-remote-action="fav" class="p-2 text-sm ${
            isFav ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
          } active:scale-125 transition">
            <i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-star pointer-events-none"></i>
          </button>
          <button data-remote-id="${escapeAttr(ch.id)}" data-remote-action="tune"
                  class="w-7 h-7 rounded-lg ${isPlayingOnTv ? 'bg-brand-500 text-white' : 'bg-brand-600/20 text-brand-400 hover:bg-brand-600 hover:text-white'} flex items-center justify-center active:scale-90 hover:scale-105 transition shadow-sm" title="Play on Quant TV">
            <i class="fa-solid fa-play text-[10px] pointer-events-none"></i>
          </button>
        </div>
      </div>
    `;
    })
    .join('');

  if (hasMore) {
    html += `
      <div class="py-3 flex justify-center shrink-0">
        <button onclick="window.loadMoreRemoteChannels()" class="w-full py-2.5 bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 text-xs rounded-xl font-medium border border-slate-800 transition flex items-center justify-center gap-2 shadow-lg">
          <i class="fa-solid fa-arrow-down text-brand-400 text-xs"></i>
          <span>Load More Channels (${list.length - sliceLimit} remaining)...</span>
        </button>
      </div>
    `;
  } else if (list.length > 20) {
    html += `
      <div class="py-4 text-center text-[10px] text-slate-500 font-mono shrink-0">
        All ${list.length} channels loaded
      </div>
    `;
  }

  container.innerHTML = html;
  attachRemoteListDelegation(container);

  // Auto-infinite scroll when scrolling near bottom
  if (!container.dataset.hasScrollListener) {
    container.dataset.hasScrollListener = 'true';
    container.addEventListener('scroll', () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 250) {
        const curLimit = state.remoteLimit || 60;
        if (curLimit < list.length) {
          state.remoteLimit = curLimit + 60;
          renderRemoteChannelsList();
        }
      }
    }, { passive: true });
  }

  if (loadMoreBtn) {
    loadMoreBtn.classList.add('hidden');
  }
}

export function renderRemoteFavsList(): void {
  const container = document.getElementById('remote-favs-render');
  if (!container) return;
  const favs = state.channels.filter(ch => state.favorites.includes(ch.id));
  if (favs.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-xs text-slate-500 flex flex-col items-center gap-2">
        <i class="fa-regular fa-star text-2xl text-slate-600"></i>
        <span>No favorite channels starred yet.</span>
        <span class="text-[10px] text-slate-600">Tap the star on any channel to pin it here.</span>
      </div>`;
    return;
  }
  container.innerHTML = favs
    .map(ch => {
      const safeName = (ch.name || 'Stream Channel').replace(/'/g, "\\'");
      const safeUrl = (ch.url || '').replace(/'/g, "\\'");
      const safeLogo = (ch.logo || '').replace(/'/g, "\\'");
      const safeProg = (ch.program || 'Live Broadcast').replace(/'/g, "\\'");

      return `
      <div onclick="sendRemoteCmd('TUNE_CHANNEL', { id: '${ch.id}', url: '${safeUrl}', name: '${safeName}', logo: '${safeLogo}', program: '${safeProg}' })" class="p-2.5 bg-slate-900 rounded-xl flex items-center justify-between active:bg-slate-800 transition">
        <div class="flex items-center gap-3 overflow-hidden">
          <img src="${ch.logo || FALLBACK_LOGO}" referrerpolicy="no-referrer" onerror="handleLogoError(this)" class="w-8 h-8 rounded object-contain bg-slate-800 p-0.5 border border-slate-700 shrink-0">
          <div class="text-left overflow-hidden">
            <div class="text-xs font-semibold text-white truncate">${ch.name}</div>
            <div class="text-[10px] text-slate-400">${ch.group || 'Live Stream'}</div>
          </div>
        </div>
        <button onclick="window.toggleRemoteFav('${ch.id}', event)" class="p-2 text-sm text-amber-400 active:scale-125 transition">
          <i class="fa-solid fa-star"></i>
        </button>
      </div>
    `;
    })
    .join('');
}

export function openRemoteMovieExplorerById(chId: string): void {
  const ch = state.channels.find(c => c.id === chId);
  if (!ch) return;
  const modal = document.getElementById('rem-modal-movie');
  if (!modal) return;

  const title = document.getElementById('rem-movie-title');
  const poster = document.getElementById('rem-movie-poster') as HTMLImageElement | null;
  const rating = document.getElementById('rem-movie-rating');
  const genre = document.getElementById('rem-movie-genre');
  const year = document.getElementById('rem-movie-year');
  const director = document.getElementById('rem-movie-director');
  const plot = document.getElementById('rem-movie-plot');
  const btnPlay = document.getElementById('rem-btn-play-movie');

  if (title) title.textContent = ch.name;
  if (poster) poster.src = ch.cover || ch.logo || FALLBACK_LOGO;
  if (rating) rating.textContent = ch.rating ? `${ch.rating} / 10` : '8.5 / 10';
  if (genre) genre.textContent = ch.genre || ch.group || 'VOD Movie';
  if (year) year.textContent = ch.releaseDate || '2024';
  if (director) director.textContent = ch.director || 'Official Production';
  if (plot) plot.textContent = ch.plot || `High definition movie stream: ${ch.name}. Tap below to play on TV.`;

  if (btnPlay) {
    btnPlay.onclick = () => {
      closeRemoteMovieExplorer();
      sendRemoteCmd('TUNE_CHANNEL', {
        id: ch.id,
        url: ch.url,
        name: ch.name,
        logo: ch.logo,
        program: ch.group || 'VOD Movie',
        type: 'vod'
      });
    };
  }

  const vodId = ch.vodId || (ch.id && ch.id.startsWith('xt_vod_') ? ch.id.replace('xt_vod_', '') : null);
  const btnCastMovie = document.getElementById('rem-btn-cast-movie');
  if (btnCastMovie) {
    btnCastMovie.onclick = () => {
      closeRemoteMovieExplorer();
      sendRemoteCmd('OPEN_MOVIE_EXPLORER', { id: ch.id, vodId: vodId });
    };
  }

  modal.classList.remove('hidden');

  if (vodId && xtreamConnector) {
    xtreamConnector
      .fetchVodInfo(vodId)
      .then(infoData => {
        if (infoData && infoData.info) {
          const info = infoData.info;
          if (poster && (info.movie_image || info.cover_big)) poster.src = info.movie_image || info.cover_big;
          if (rating && info.rating) rating.textContent = `${info.rating} / 10`;
          if (genre && info.genre) genre.textContent = info.genre;
          if (year && (info.releasedate || info.year)) year.textContent = info.releasedate || info.year;
          if (director && info.director) director.textContent = info.director;
          if (plot && (info.description || info.plot)) plot.textContent = info.description || info.plot;
        }
      })
      .catch(() => {});
  }
}

export function closeRemoteMovieExplorer(): void {
  const modal = document.getElementById('rem-modal-movie');
  if (modal) modal.classList.add('hidden');
}

let remoteCurrentSeriesCache: { info: any; channel: Channel } | null = null;

export async function openRemoteSeriesExplorerById(chId: string): Promise<void> {
  const ch = state.channels.find(c => c.id === chId);
  if (!ch) return;
  const modal = document.getElementById('rem-modal-series');
  if (!modal) return;

  const title = document.getElementById('rem-series-title');
  const poster = document.getElementById('rem-series-poster') as HTMLImageElement | null;
  const rating = document.getElementById('rem-series-rating');
  const genre = document.getElementById('rem-series-genre');
  const year = document.getElementById('rem-series-year');
  const cast = document.getElementById('rem-series-cast');
  const plot = document.getElementById('rem-series-plot');
  const tabs = document.getElementById('rem-series-season-tabs');
  const list = document.getElementById('rem-series-episode-list');

  if (title) title.textContent = ch.name;
  if (poster) poster.src = ch.cover || ch.logo || FALLBACK_LOGO;
  if (rating) rating.textContent = ch.rating ? `${ch.rating} / 10` : '8.9 / 10';
  if (genre) genre.textContent = ch.genre || ch.group || 'TV Series';
  if (year) year.textContent = ch.releaseDate || '2024';
  if (cast) cast.textContent = ch.cast || 'Starring ensemble cast';
  if (plot) plot.textContent = ch.plot || `Full seasons and episodes of ${ch.name}. Select a season and episode to play on TV.`;

  if (tabs) tabs.innerHTML = `<div class="text-xs text-slate-400 p-2"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Loading seasons...</div>`;
  if (list) list.innerHTML = '';

  let seriesId = ch.seriesId;
  if (!seriesId && ch.url && ch.url.includes('/series/')) {
    const parts = ch.url.split('/');
    seriesId = parts[parts.length - 1]?.split('.')[0];
  }

  const btnCastSeries = document.getElementById('rem-btn-cast-series');
  if (btnCastSeries) {
    btnCastSeries.onclick = () => {
      closeRemoteSeriesExplorer();
      sendRemoteCmd('OPEN_SERIES_EXPLORER', { id: ch.id, seriesId: seriesId });
    };
  }

  modal.classList.remove('hidden');

  if (seriesId && xtreamConnector) {
    const info = await xtreamConnector.fetchSeriesInfo(seriesId, ch);
    if (info && info.episodes && Object.keys(info.episodes).length > 0) {
      remoteCurrentSeriesCache = { info, channel: ch };
      renderRemoteSeriesSeasonsAndEpisodes(info, ch);
      return;
    }
  }

  if (tabs) tabs.innerHTML = `<button class="px-3 py-1 rounded-xl bg-brand-600 text-white font-bold text-xs">Season 1</button>`;
  if (list) {
    list.innerHTML = `
      <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
        <span class="text-xs text-white font-semibold">${ch.name} - Direct Stream</span>
        <button onclick="window.closeRemoteSeriesExplorer(); sendRemoteCmd('TUNE_CHANNEL', { id: '${ch.id}', url: '${ch.url.replace(
      /'/g,
      "\\'"
    )}', name: '${ch.name.replace(/'/g, "\\'")}', logo: '${(ch.logo || '').replace(/'/g, "\\'")}', program: '${(
      ch.group || 'TV Series'
    ).replace(/'/g, "\\'")}', type: 'series' })" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs flex items-center gap-1.5">
          <i class="fa-solid fa-play text-[10px]"></i> Play on TV
        </button>
      </div>
    `;
  }
}

export function renderRemoteSeriesSeasonsAndEpisodes(info: any, _ch: Channel): void {
  if (!info || !info.episodes) return;
  const episodesObj = info.episodes;
  const seasonNums = Object.keys(episodesObj).sort((a, b) => Number(a) - Number(b));

  const seasonsHtml = seasonNums
    .map(
      (sNum, idx) => `
    <button onclick="window.selectRemoteSeriesSeason('${sNum}')" id="rem-season-btn-${sNum}" class="rem-season-btn px-3 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 ${
        idx === 0 ? 'bg-brand-600 border-brand-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'
      }">
      Season ${sNum}
    </button>
  `
    )
    .join('');

  const tabs = document.getElementById('rem-series-season-tabs');
  if (tabs) tabs.innerHTML = seasonsHtml;

  if (seasonNums.length > 0) {
    selectRemoteSeriesSeason(seasonNums[0]);
  }
}

export function selectRemoteSeriesSeason(seasonNum: string): void {
  if (!remoteCurrentSeriesCache || !remoteCurrentSeriesCache.info) return;
  document.querySelectorAll('.rem-season-btn').forEach(btn => {
    btn.className =
      'rem-season-btn px-3 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 bg-slate-800 border-slate-700 text-slate-400';
  });

  const activeBtn = document.getElementById(`rem-season-btn-${seasonNum}`);
  if (activeBtn) {
    activeBtn.className =
      'rem-season-btn px-3 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 bg-brand-600 border-brand-500 text-white';
  }

  const episodes = remoteCurrentSeriesCache.info.episodes[seasonNum] || [];
  const ch = remoteCurrentSeriesCache.channel;
  const creds = getXtreamCredentials(ch);
  const host = creds.host || state.lastXtreamHost || '';
  const user = creds.username || state.lastXtreamUser || '';
  const pass = creds.password || state.lastXtreamPass || '';

  const epListHtml = episodes
    .map((ep: any) => {
      const ext = ep.container_extension || 'mp4';
      const epUrl = `${host}/series/${user}/${pass}/${ep.id}.${ext}`;
      const title = ep.title || `Episode ${ep.episode_num || ''}`;
      const epCode = `S${String(seasonNum).padStart(2, '0')}E${String(ep.episode_num || 1).padStart(2, '0')}`;
      const safeTitle = (ch.name + ' - ' + epCode + ' ' + title).replace(/'/g, "\\'");
      const safeEpUrl = epUrl.replace(/'/g, "\\'");
      const safeLogo = (ch.logo || '').replace(/'/g, "\\'");

      return `
      <div class="bg-slate-950 p-3 rounded-xl border border-slate-800/80 flex items-center justify-between gap-2 text-left">
        <div class="overflow-hidden pr-2">
          <div class="text-xs font-bold text-white truncate">${title}</div>
          <div class="text-[10px] text-slate-400 font-mono">${epCode} · ${
        ep.info && ep.info.duration ? ep.info.duration : 'Episode'
      }</div>
        </div>
        <button onclick="window.closeRemoteSeriesExplorer(); sendRemoteCmd('TUNE_CHANNEL', { id: 'ep_${
          ep.id
        }', url: '${safeEpUrl}', name: '${safeTitle}', logo: '${safeLogo}', program: 'TV Series Episode', type: 'series' })" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shrink-0 active:scale-95 transition flex items-center gap-1">
          <i class="fa-solid fa-play text-[10px]"></i> Play
        </button>
      </div>
    `;
    })
    .join('');

  const list = document.getElementById('rem-series-episode-list');
  if (list) list.innerHTML = epListHtml || `<div class="p-3 text-xs text-slate-500 text-center">No episodes in Season ${seasonNum}.</div>`;
}

export function closeRemoteSeriesExplorer(): void {
  const modal = document.getElementById('rem-modal-series');
  if (modal) modal.classList.add('hidden');
}

export function clearTvSearch(): void {
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const clearBtn = document.getElementById('search-clear-btn');
  if (searchInput) {
    searchInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    filterChannels();
    searchInput.focus();
  }
}

export function clearRemoteSearch(): void {
  const searchInput = document.getElementById('remote-search-input') as HTMLInputElement | null;
  const clearBtn = document.getElementById('remote-search-clear');
  if (searchInput) {
    searchInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    state.remoteLimit = 60;
    const container = document.getElementById('remote-channels-render');
    if (container) container.scrollTop = 0;
    renderRemoteChannelsList();
    searchInput.focus();
  }
}

export function loadMoreRemoteChannels(): void {
  state.remoteLimit += 60;
  renderRemoteChannelsList();
}

(window as any).playChannel = playChannel;
(window as any).tuneToChannel = tuneToChannel;
(window as any).toggleFavorite = toggleFavorite;
(window as any).filterChannels = filterChannels;
(window as any).clearTvSearch = clearTvSearch;
(window as any).filterContentType = filterContentType;
(window as any).renderChannelList = renderChannelList;
(window as any).loadMoreTvChannels = loadMoreTvChannels;
(window as any).updateFavoritesUI = updateFavoritesUI;
(window as any).updateLanguageDropdown = updateLanguageDropdown;
(window as any).renderRemoteChannelsList = renderRemoteChannelsList;
(window as any).renderRemoteFavsList = renderRemoteFavsList;
(window as any).openRemoteMovieExplorerById = openRemoteMovieExplorerById;
(window as any).closeRemoteMovieExplorer = closeRemoteMovieExplorer;
(window as any).openRemoteSeriesExplorerById = openRemoteSeriesExplorerById;
(window as any).closeRemoteSeriesExplorer = closeRemoteSeriesExplorer;
(window as any).selectRemoteSeriesSeason = selectRemoteSeriesSeason;
(window as any).clearRemoteSearch = clearRemoteSearch;
(window as any).loadMoreRemoteChannels = loadMoreRemoteChannels;
(window as any).renderQuickChannelStrip = renderQuickChannelStrip;

(window as any).renderRemoteFilterBar = renderRemoteFilterBar;
(window as any).resetRemoteFilters = resetRemoteFilters;
