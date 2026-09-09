import { Channel } from '../types';
import { state, FALLBACK_LOGO } from '../state/store';
import { userProfile } from '../state/user-profile';
import { circuitBreaker } from '../player/circuit-breaker';
import { playbackMachine } from '../player/playback-machine';
import { quarantineManager } from '../services/m3u';
import { xtreamConnector, getXtreamCredentials } from '../services/xtream';
import { QuantumStreamEngine } from '../player/engine';
import { broadcastTVState } from '../services/remote';

let engineInstance: QuantumStreamEngine | null = null;
let currentSeriesInfoCache: any = null;
let isSeriesExpanded = false;

export function setModalEngineInstance(engine: QuantumStreamEngine): void {
  engineInstance = engine;
}

export function closeRemoteModal(): void {
  const modal = document.getElementById('modal-remote');
  if (modal) modal.classList.add('hidden');
}

export function closeM3uModal(): void {
  const modal = document.getElementById('modal-m3u');
  if (modal) modal.classList.add('hidden');
}

export function closeModals(): void {
  closeRemoteModal();
  closeM3uModal();
  closeQuarantineModal();
  closeSeriesExplorer();
  closeMovieExplorer();
  const modalRemoteMovie = document.getElementById('modal-remote-movie-explorer');
  const modalRemoteSeries = document.getElementById('modal-remote-series-explorer');
  if (modalRemoteMovie) modalRemoteMovie.classList.add('hidden');
  if (modalRemoteSeries) modalRemoteSeries.classList.add('hidden');
  const modalAppDialog = document.getElementById('modal-app-dialog');
  if (modalAppDialog) modalAppDialog.classList.add('hidden');
}

// Global backdrop click dismissal and Escape key handling
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target) return;
    const modalIds = [
      'modal-remote',
      'modal-m3u',
      'modal-quarantine',
      'modal-series-explorer',
      'modal-movie-explorer',
      'modal-remote-movie-explorer',
      'modal-remote-series-explorer'
    ];
    if (modalIds.includes(target.id)) {
      target.classList.add('hidden');
    }
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeModals();
    }
  });
}

export async function openSeriesExplorer(channel: Channel): Promise<void> {
  if (!channel) return;
  const modal = document.getElementById('modal-series-explorer');
  if (!modal) return;

  const titleHeader = document.getElementById('series-header-title');
  const titleMain = document.getElementById('series-title');
  const poster = document.getElementById('series-poster') as HTMLImageElement | null;
  const ratingVal = document.getElementById('series-rating-val');
  const genre = document.getElementById('series-genre');
  const year = document.getElementById('series-year');
  const director = document.getElementById('series-director');
  const cast = document.getElementById('series-cast');
  const plot = document.getElementById('series-plot');
  const tabs = document.getElementById('series-seasons-tabs');
  const grid = document.getElementById('series-episodes-grid');

  if (titleHeader) titleHeader.textContent = channel.name;
  if (titleMain) titleMain.textContent = channel.name;
  if (poster) poster.src = channel.cover || channel.logo || FALLBACK_LOGO;
  if (ratingVal) ratingVal.textContent = channel.rating ? `${channel.rating} / 10` : '8.9 / 10';
  if (genre) genre.textContent = channel.genre || channel.group || 'TV Series';
  if (year) year.textContent = channel.releaseDate || '2024';
  if (director) director.innerHTML = `<i class="fa-solid fa-video mr-1 text-slate-500"></i>${channel.director || 'Official Production'}`;
  if (cast) cast.textContent = channel.cast || 'Starring ensemble cast';
  if (plot) plot.textContent = channel.plot || `Watch full seasons and high-definition episodes of ${channel.name} with stream player controls.`;

  if (tabs) {
    tabs.innerHTML = `<div class="px-3 py-1.5 text-xs text-slate-400 flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-brand-400 animate-pulse"></span>Loading series seasons & episodes...</div>`;
  }
  if (grid) grid.innerHTML = '';
  modal.classList.remove('hidden');

  if (channel.seriesId && xtreamConnector) {
    const info = await xtreamConnector.fetchSeriesInfo(channel.seriesId, channel);
    currentSeriesInfoCache = info;
    if (info && info.episodes && Object.keys(info.episodes).length > 0) {
      renderSeriesSeasonsAndEpisodes(info);
      return;
    }
  }

  // Fallback direct launcher
  const sCount = document.getElementById('series-season-count');
  const eCount = document.getElementById('series-episode-count');
  const bCount = document.getElementById('episodes-counter-badge');
  if (sCount) sCount.textContent = '1 Season';
  if (eCount) eCount.textContent = '1 Stream';
  if (bCount) bCount.textContent = '1 Direct Stream';
  if (tabs) tabs.innerHTML = `<button class="px-3 py-1.5 rounded-xl bg-brand-600 text-white font-bold text-xs shadow">Season 1</button>`;

  if (grid) {
    grid.innerHTML = `
      <div class="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between space-y-3 hover:border-brand-500/50 transition shadow-lg">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-white">${channel.name}</span>
          <span class="px-2 py-0.5 rounded bg-brand-950 text-brand-300 text-[10px] font-mono font-bold">S01E01</span>
        </div>
        <p class="text-[10px] text-slate-400 font-mono truncate">${channel.url}</p>
        <button onclick="window.playEpisodeStream('${channel.url}', '${channel.name.replace(/'/g, "\\'")}')" class="w-full py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs transition flex items-center justify-center gap-1.5 shadow">
          <i class="fa-solid fa-play text-[10px]"></i>Play Direct Series Stream
        </button>
      </div>
    `;
  }
}

export function renderSeriesSeasonsAndEpisodes(info: any): void {
  if (!info || !info.episodes) return;
  const episodesObj = info.episodes;
  const seasonNums = Object.keys(episodesObj).sort((a, b) => Number(a) - Number(b));

  let totalEpisodes = 0;
  seasonNums.forEach(s => {
    totalEpisodes += episodesObj[s] ? episodesObj[s].length : 0;
  });

  const sCount = document.getElementById('series-season-count');
  const eCount = document.getElementById('series-episode-count');
  const bCount = document.getElementById('episodes-counter-badge');
  if (sCount) sCount.textContent = `${seasonNums.length} Season${seasonNums.length > 1 ? 's' : ''}`;
  if (eCount) eCount.textContent = `${totalEpisodes} Episodes`;
  if (bCount) bCount.textContent = `${totalEpisodes} Available Episodes`;

  const seasonsHtml = seasonNums
    .map(
      (sNum, idx) => `
    <button onclick="window.selectSeriesSeason('${sNum}')" id="season-tab-${sNum}" class="season-tab-btn px-3.5 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 ${
        idx === 0
          ? 'bg-brand-600 border-brand-500 text-white shadow-md'
          : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white'
      }">
      Season ${sNum}
    </button>
  `
    )
    .join('');

  const tabs = document.getElementById('series-seasons-tabs');
  if (tabs) tabs.innerHTML = seasonsHtml;

  if (seasonNums.length > 0) {
    selectSeriesSeason(seasonNums[0]);
  }
}

export function selectSeriesSeason(seasonNum: string): void {
  if (!currentSeriesInfoCache || !currentSeriesInfoCache.episodes) return;
  document.querySelectorAll('.season-tab-btn').forEach(btn => {
    btn.className =
      'season-tab-btn px-3.5 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white';
  });

  const activeBtn = document.getElementById(`season-tab-${seasonNum}`);
  if (activeBtn) {
    activeBtn.className =
      'season-tab-btn px-3.5 py-1.5 rounded-xl font-bold text-xs transition border shrink-0 bg-brand-600 border-brand-500 text-white shadow-md';
  }

  const episodes = currentSeriesInfoCache.episodes[seasonNum] || [];
  const creds = getXtreamCredentials();
  const host = creds.host || state.lastXtreamHost || '';
  const username = creds.username || state.lastXtreamUser || '';
  const password = creds.password || state.lastXtreamPass || '';

  const gridHtml = episodes
    .map((ep: any) => {
      const ext = ep.container_extension || 'mkv';
      const epUrl = `${host}/series/${username}/${password}/${ep.id}.${ext}`;
      const title = ep.title || `Episode ${ep.episode_num || ''}`;
      const epNumStr = `S${String(seasonNum).padStart(2, '0')}E${String(ep.episode_num || 1).padStart(2, '0')}`;

      return `
      <div class="bg-slate-950/80 border border-slate-800/90 hover:border-brand-500/60 rounded-2xl p-3 flex flex-col justify-between space-y-2.5 transition shadow-lg group">
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="text-xs font-bold text-white group-hover:text-brand-300 transition line-clamp-1">${title}</span>
            <span class="text-[10px] text-slate-400 font-mono block">${ep.info && ep.info.duration ? ep.info.duration : 'Standard Episode'}</span>
          </div>
          <span class="px-2 py-0.5 rounded-md bg-brand-950 text-brand-300 border border-brand-800/60 text-[9px] font-mono font-bold shrink-0">${epNumStr}</span>
        </div>
        <button onclick="window.playEpisodeStream('${epUrl}', '${title.replace(/'/g, "\\'")}')" class="w-full py-2 rounded-xl bg-slate-800 hover:bg-brand-600 text-slate-200 hover:text-white font-semibold text-xs transition flex items-center justify-center gap-2 border border-slate-700/60 hover:border-brand-500 shadow active:scale-95">
          <i class="fa-solid fa-play text-[10px] text-brand-400 group-hover:text-white"></i>Play Episode
        </button>
      </div>
    `;
    })
    .join('');

  const grid = document.getElementById('series-episodes-grid');
  if (grid) {
    grid.innerHTML =
      gridHtml || `<div class="p-4 text-center text-slate-500 text-xs col-span-full">No episodes found for Season ${seasonNum}.</div>`;
  }
}

export function toggleSeriesExpandView(): void {
  const box = document.getElementById('series-explorer-box');
  const label = document.getElementById('series-expand-label');
  const icon = document.getElementById('series-expand-icon');
  if (!box) return;

  isSeriesExpanded = !isSeriesExpanded;
  if (isSeriesExpanded) {
    box.className =
      'bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-7xl shadow-2xl relative h-[95vh] flex flex-col overflow-hidden transition-all duration-300';
    if (label) label.textContent = 'Contract';
    if (icon) icon.className = 'fa-solid fa-compress text-[11px]';
  } else {
    box.className =
      'bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl shadow-2xl relative max-h-[90vh] flex flex-col overflow-hidden transition-all duration-300';
    if (label) label.textContent = 'Expand';
    if (icon) icon.className = 'fa-solid fa-expand text-[11px]';
  }
}

export function closeSeriesExplorer(): void {
  const modal = document.getElementById('modal-series-explorer');
  if (modal) modal.classList.add('hidden');
}

export function playEpisodeStream(streamUrl: string, episodeTitle = 'Episode'): void {
  closeSeriesExplorer();
  const currentChName = document.getElementById('current-ch-name');
  const currentChEpg = document.getElementById('current-ch-epg');
  if (currentChName) currentChName.textContent = episodeTitle;
  if (currentChEpg) currentChEpg.textContent = 'TV Series Episode';
  engineInstance?.load(streamUrl);
}

export async function openMovieExplorer(channel: Channel): Promise<void> {
  if (!channel) return;
  const modal = document.getElementById('modal-movie-explorer');
  if (!modal) return;

  const titleHeader = document.getElementById('movie-header-title');
  const titleMain = document.getElementById('movie-title');
  const poster = document.getElementById('movie-poster') as HTMLImageElement | null;
  const ratingVal = document.getElementById('movie-rating-val');
  const genre = document.getElementById('movie-genre');
  const year = document.getElementById('movie-year');
  const duration = document.getElementById('movie-duration');
  const director = document.getElementById('movie-director');
  const cast = document.getElementById('movie-cast');
  const plot = document.getElementById('movie-plot');
  const btnPlay = document.getElementById('btn-play-movie-now');
  const btnFav = document.getElementById('btn-movie-fav-toggle');

  if (titleHeader) titleHeader.textContent = channel.name;
  if (titleMain) titleMain.textContent = channel.name;
  if (poster) poster.src = channel.cover || channel.logo || FALLBACK_LOGO;
  if (ratingVal) ratingVal.textContent = channel.rating ? `${channel.rating} / 10` : '8.5 / 10';
  if (genre) genre.textContent = channel.genre || channel.group || 'VOD Movie';
  if (year) year.textContent = channel.releaseDate || '2024';
  if (duration) duration.innerHTML = `<i class="fa-regular fa-clock mr-1 text-[10px]"></i>${channel.duration || '2h 00m'}`;
  if (director) director.textContent = channel.director || 'Official Production';
  if (cast) cast.textContent = channel.cast || 'Starring ensemble cast';
  if (plot) plot.textContent = channel.plot || `Watch high-definition movie stream for ${channel.name}. Click Play Movie Now to start watching.`;

  if (btnFav) {
    const isFav = state.favorites.includes(channel.id);
    btnFav.innerHTML = isFav ? '<i class="fa-solid fa-star text-amber-400 mr-1"></i>Favorited' : '<i class="fa-regular fa-star mr-1"></i>Favorite';
    btnFav.onclick = (e) => {
      (window as any).toggleFavorite?.(channel.id, e);
      const nowFav = state.favorites.includes(channel.id);
      btnFav.innerHTML = nowFav ? '<i class="fa-solid fa-star text-amber-400 mr-1"></i>Favorited' : '<i class="fa-regular fa-star mr-1"></i>Favorite';
    };
  }

  if (btnPlay) {
    btnPlay.onclick = () => {
      closeMovieExplorer();
      startMoviePlayback(channel);
    };
  }

  modal.classList.remove('hidden');

  const vodId = channel.vodId || (channel.id && channel.id.startsWith('xt_vod_') ? channel.id.replace('xt_vod_', '') : null);
  if (vodId && xtreamConnector) {
    const infoData = await xtreamConnector.fetchVodInfo(vodId);
    if (infoData && infoData.info) {
      const info = infoData.info;
      if (poster && (info.movie_image || info.cover_big)) poster.src = info.movie_image || info.cover_big;
      if (ratingVal && info.rating) ratingVal.textContent = `${info.rating} / 10`;
      if (genre && info.genre) genre.textContent = info.genre;
      if (year && (info.releasedate || info.year)) year.textContent = info.releasedate || info.year;
      if (duration && (info.duration || info.duration_secs)) {
        const mins = info.duration ? info.duration : `${Math.floor(info.duration_secs / 60)} mins`;
        duration.innerHTML = `<i class="fa-regular fa-clock mr-1 text-[10px]"></i>${mins}`;
      }
      if (director && info.director) director.textContent = info.director;
      if (cast && (info.actors || info.cast)) cast.textContent = info.actors || info.cast;
      if (plot && (info.description || info.plot)) plot.textContent = info.description || info.plot;
    }
  }
}

export function closeMovieExplorer(): void {
  const modal = document.getElementById('modal-movie-explorer');
  if (modal) modal.classList.add('hidden');
}

export function startMoviePlayback(channel: Channel): void {
  if (!channel) return;
  const idx = state.filteredChannels.findIndex(c => c.id === channel.id);
  if (idx !== -1) {
    state.currentChannelIndex = idx;
  }
  const currentChName = document.getElementById('current-ch-name');
  const currentChLogo = document.getElementById('current-ch-logo') as HTMLImageElement | null;
  const currentChEpg = document.getElementById('current-ch-epg');

  if (currentChName) currentChName.textContent = channel.name;
  if (currentChLogo) currentChLogo.src = channel.logo || FALLBACK_LOGO;
  if (currentChEpg) currentChEpg.textContent = channel.group || 'VOD Movie';

  userProfile.recordWatchEvent(channel, 5);
  engineInstance?.load(channel.url);
  (window as any).renderChannelList?.();
  broadcastTVState();
}

export function openQuarantineModal(): void {
  const modal = document.getElementById('modal-quarantine');
  if (modal) modal.classList.remove('hidden');
  switchQuarantineTab('records');
}

export function closeQuarantineModal(): void {
  const modal = document.getElementById('modal-quarantine');
  if (modal) modal.classList.add('hidden');
}

let activeQuarantineTab = 'records';

export function switchQuarantineTab(tabName: string): void {
  activeQuarantineTab = tabName;
  ['records', 'breakers', 'telemetry'].forEach(t => {
    const btn = document.getElementById(`tab-quarantine-${t}`);
    if (btn) {
      if (t === tabName) {
        btn.className = 'pb-2 border-b-2 border-amber-500 text-amber-400 font-bold transition';
      } else {
        btn.className = 'pb-2 border-b-2 border-transparent text-slate-400 font-semibold hover:text-white transition';
      }
    }
  });
  renderQuarantineTab();
}

export function renderQuarantineTab(): void {
  const area = document.getElementById('quarantine-content-area');
  if (!area) return;

  if (activeQuarantineTab === 'records') {
    const records = quarantineManager.quarantinedRecords;
    if (records.length === 0) {
      area.innerHTML = `<div class="p-6 text-center text-slate-500 font-sans text-xs">No quarantined records logged. Parser is operating cleanly.</div>`;
      return;
    }
    area.innerHTML = records
      .map(
        r => `
      <div class="p-2.5 bg-slate-950/70 rounded-lg border border-amber-500/20 flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px]">
          <span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">${r.reason}</span>
          <span class="text-slate-500">${r.timestamp}</span>
        </div>
        <div class="text-[11px] text-slate-200 truncate">${r.record}</div>
        <div class="text-[9px] text-slate-500 truncate">${r.sourceUrl}</div>
      </div>
    `
      )
      .join('');
  } else if (activeQuarantineTab === 'breakers') {
    const entries = Array.from(circuitBreaker.hosts.entries());
    if (entries.length === 0) {
      area.innerHTML = `<div class="p-6 text-center text-slate-500 font-sans text-xs">All host endpoints healthy. Circuit breakers closed.</div>`;
      return;
    }
    area.innerHTML = entries
      .map(
        ([host, info]) => `
      <div class="p-2.5 bg-slate-950/70 rounded-lg border border-slate-800 flex items-center justify-between">
        <div>
          <div class="text-xs font-bold text-white">${host}</div>
          <div class="text-[10px] text-slate-400">Failures: ${info.failures}</div>
        </div>
        <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
          info.state === 'OPEN'
            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
            : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
        }">${info.state}</span>
      </div>
    `
      )
      .join('');
  } else if (activeQuarantineTab === 'telemetry') {
    const attempts = playbackMachine.attempts;
    if (attempts.length === 0) {
      area.innerHTML = `<div class="p-6 text-center text-slate-500 font-sans text-xs">No stream attempt telemetry logged yet.</div>`;
      return;
    }
    area.innerHTML = attempts
      .map(
        att => `
      <div class="p-2.5 bg-slate-950/70 rounded-lg border border-slate-800 flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px]">
          <span class="font-bold text-white truncate max-w-[200px]">${att.channelName}</span>
          <span class="px-1.5 py-0.5 rounded font-bold ${
            att.outcome === 'PLAYING' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
          }">${att.outcome}</span>
        </div>
        <div class="text-[10px] text-slate-400 flex items-center gap-3">
          <span>Duration: ${((att.durationMs || 0) / 1000).toFixed(1)}s</span>
          <span>Events: ${att.events.length}</span>
        </div>
      </div>
    `
      )
      .join('');
  }
}

export function toggleSubtitlePopover(e?: MouseEvent): void {
  if (e) e.stopPropagation();
  const popSub = document.getElementById('popover-subtitles');
  const popAud = document.getElementById('popover-audio');
  if (popAud) popAud.classList.add('hidden');
  if (popSub) {
    popSub.classList.toggle('hidden');
    if (!popSub.classList.contains('hidden')) {
      engineInstance?.updateSubtitlesAndAudioTracks();
    }
  }
}

export function toggleAudioPopover(e?: MouseEvent): void {
  if (e) e.stopPropagation();
  const popSub = document.getElementById('popover-subtitles');
  const popAud = document.getElementById('popover-audio');
  if (popSub) popSub.classList.add('hidden');
  if (popAud) {
    popAud.classList.toggle('hidden');
    if (!popAud.classList.contains('hidden')) {
      engineInstance?.updateSubtitlesAndAudioTracks();
    }
  }
}

export function selectSubtitleTrack(trackIdx: number): void {
  if (engineInstance?.hls) {
    engineInstance.hls.subtitleTrack = trackIdx;
  }
  const label = document.getElementById('subtitles-label');
  if (label) label.textContent = trackIdx === -1 ? 'Off' : `Track ${trackIdx + 1}`;
  const popSub = document.getElementById('popover-subtitles');
  if (popSub) popSub.classList.add('hidden');
}

export function selectNativeSubtitleTrack(trackIdx: number): void {
  if (engineInstance?.video && engineInstance.video.textTracks) {
    Array.from(engineInstance.video.textTracks).forEach((tr, i) => {
      tr.mode = i === trackIdx ? 'showing' : 'disabled';
    });
  }
  const label = document.getElementById('subtitles-label');
  if (label) label.textContent = trackIdx === -1 ? 'Off' : `Track ${trackIdx + 1}`;
  const popSub = document.getElementById('popover-subtitles');
  if (popSub) popSub.classList.add('hidden');
}

export function selectAudioTrack(trackIdx: number): void {
  if (engineInstance?.hls) {
    engineInstance.hls.audioTrack = trackIdx;
  }
  const label = document.getElementById('audio-label');
  if (label) label.textContent = trackIdx === -1 ? 'Auto' : `Track ${trackIdx + 1}`;
  const popAud = document.getElementById('popover-audio');
  if (popAud) popAud.classList.add('hidden');
}

export function copyToClipboard(text: string): void {
  const tempInput = document.createElement('input');
  tempInput.style.position = 'absolute';
  tempInput.style.left = '-1000px';
  tempInput.value = text;
  document.body.appendChild(tempInput);
  tempInput.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(tempInput);
}

// Global window mappings for DOM onClick handlers
(window as any).closeModals = closeModals;
(window as any).closeRemoteModal = closeRemoteModal;
(window as any).closeM3uModal = closeM3uModal;
(window as any).openSeriesExplorer = openSeriesExplorer;
(window as any).closeSeriesExplorer = closeSeriesExplorer;
(window as any).toggleSeriesExpandView = toggleSeriesExpandView;
(window as any).selectSeriesSeason = selectSeriesSeason;
(window as any).playEpisodeStream = playEpisodeStream;
(window as any).openMovieExplorer = openMovieExplorer;
(window as any).closeMovieExplorer = closeMovieExplorer;
(window as any).startMoviePlayback = startMoviePlayback;
(window as any).openQuarantineModal = openQuarantineModal;
(window as any).closeQuarantineModal = closeQuarantineModal;
(window as any).switchQuarantineTab = switchQuarantineTab;
(window as any).renderQuarantineTab = renderQuarantineTab;
(window as any).toggleSubtitlePopover = toggleSubtitlePopover;
(window as any).toggleAudioPopover = toggleAudioPopover;
(window as any).selectSubtitleTrack = selectSubtitleTrack;
(window as any).selectNativeSubtitleTrack = selectNativeSubtitleTrack;
(window as any).selectAudioTrack = selectAudioTrack;
(window as any).copyToClipboard = copyToClipboard;
