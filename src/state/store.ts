import { Channel } from '../types';

export const FALLBACK_LOGO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%236366f1'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath fill='%23ffffff' d='M10 8l6 4-6 4V8z'/%3E%3C/svg%3E";

export function handleLogoError(img: HTMLImageElement | null): void {
  if (!img) return;
  img.onerror = null;
  img.src = FALLBACK_LOGO;
}

export function generateChannelId(name: string, url: string): string {
  const base = (url || name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'ch_' + (base.slice(-24) || Math.floor(Math.random() * 100000));
}

export const DEFAULT_PRESET_CHANNELS: Channel[] = [
  {
    id: "asianet-news",
    name: "Asianet News (Malayalam)",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/0/07/Asianet_News_logo.svg/512px-Asianet_News_logo.svg.png",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://amg13737-amg13737c1-amgplt0016.playout.now3.amagi.tv/playlist/amg13737-amg13737c1-amgplt0016/playlist.m3u8",
    sources: [
      { url: "https://amg13737-amg13737c1-amgplt0016.playout.now3.amagi.tv/playlist/amg13737-amg13737c1-amgplt0016/playlist.m3u8", sourceName: "Amagi CDN" },
      { url: "https://mumt03.tangotv.in/Dsly5z3HASIANETMIDDLEEAST/index.m3u8", sourceName: "Tango CDN" },
      { url: "https://asianetnews.vgcdn.net/vglive-sk-335835/playlist.m3u8", sourceName: "VG CDN" }
    ],
    program: "Asianet Varthakal & Prime Discussions"
  },
  {
    id: "asianet-suvarna",
    name: "Asianet Suvarna News (Kannada)",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/f/f6/Suvarna_News_Logo.png/512px-Suvarna_News_Logo.png",
    group: "News",
    country: "IN",
    language: "Kannada",
    url: "https://asianetnews.vgcdn.net/vglive-sk-335835/playlist.m3u8",
    program: "Suvarna Fast News & Karnataka Bulletins"
  },
  {
    id: "asianet-me",
    name: "Asianet Middle East",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/0/07/Asianet_News_logo.svg/512px-Asianet_News_logo.svg.png",
    group: "Entertainment",
    country: "IN",
    language: "Malayalam",
    url: "https://vidcdn.vidgyor.com/asianet-origin/liveabr/asianet-origin/live2/chunks.m3u8",
    program: "Gulf Samayam & Prime Entertainment"
  },
  {
    id: "asianet-live-2",
    name: "Asianet News Live 24/7",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/0/07/Asianet_News_logo.svg/512px-Asianet_News_logo.svg.png",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://vidcdn.vidgyor.com/asianet-origin/liveabr/asianet-origin/live2/chunks.m3u8",
    program: "Nonstop Live News Desk"
  },
  {
    id: "24-news-malayalam",
    name: "24 News (576p)",
    logo: "https://sund-images.sunnxt.com/202222/300x300_24News_202222_d63feca0-79ae-47ea-b75a-66c17d456f4c.png",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://mumt07.tangotv.in/zHjX9OFlTWENTYFOURNEWS/index.m3u8",
    program: "24 Round The Clock Malayalam News"
  },
  {
    id: "amrita-tv-malayalam",
    name: "Amrita TV (720p)",
    logo: "https://i.imgur.com/WdSjlPl.png",
    group: "Entertainment",
    country: "IN",
    language: "Malayalam",
    url: "https://ddash74r36xqp.cloudfront.net/master.m3u8",
    program: "Amrita Prime Serial & Music Shows"
  },
  {
    id: "mathrubhumi-news",
    name: "Mathrubhumi News (576p)",
    logo: "https://i.imgur.com/diQftzP.png",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://streams.tangotv.in/MATHRUBHUMINEWS/ORIGIN/index.m3u8",
    program: "Mathrubhumi Prime Discussions"
  },
  {
    id: "media-one-malayalam",
    name: "Media One (720p)",
    logo: "https://xstreamcp-assets-msp.streamready.in/assets/LIVETV/LIVECHANNEL/LIVETV_LIVETVCHANNEL_MEDIA_ONE/images/LOGO_HD/image.png",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://cdn-3.pishow.tv/live/1481/master.m3u8",
    program: "Media One Special Focus"
  },
  {
    id: "reporter-tv-malayalam",
    name: "Reporter TV (576p)",
    logo: "https://dtil.tmsimg.com/assets/s85096_ld_h15_aa.png?lock=720x540",
    group: "News",
    country: "IN",
    language: "Malayalam",
    url: "https://segment.yuppcdn.net/050522/reporter/playlist.m3u8",
    program: "Reporter Live Breaking News"
  },
  {
    id: "jaya-tv-hd",
    name: "Jaya TV (Tamil)",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/e/e0/Jaya_TV_Logo.png/512px-Jaya_TV_Logo.png",
    group: "Entertainment",
    country: "IN",
    language: "Tamil",
    url: "https://amg01443-amg01443c1-amgplt0016.playout.now3.amagi.tv/playlist/amg01443-amg01443c1-amgplt0016/playlist.m3u8",
    program: "Jaya Special Prime Entertainment & Tamil Serial"
  },
  {
    id: "jaya-plus-news",
    name: "Jaya Plus News (Tamil)",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/e/e0/Jaya_TV_Logo.png/512px-Jaya_TV_Logo.png",
    group: "News",
    country: "IN",
    language: "Tamil",
    url: "https://amg01443-amg01443c1-amgplt0016.playout.now3.amagi.tv/playlist/amg01443-amg01443c1-amgplt0016/playlist.m3u8",
    program: "Tamilnadu Breaking News & Daily Bulletins"
  },
  {
    id: "sun-news-tamil",
    name: "Sun News (Tamil)",
    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/8/86/Sun_News_logo.png/512px-Sun_News_logo.png",
    group: "News",
    country: "IN",
    language: "Tamil",
    url: "https://sunnews.akamaized.net/hls/live/2034034/sunnews/master.m3u8",
    program: "Sun News Tamil Headlines & Debates"
  },
  {
    id: "thanthi-tv",
    name: "Thanthi TV (Tamil)",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Thanthi_TV_logo.svg/512px-Thanthi_TV_logo.svg.png",
    group: "News",
    country: "IN",
    language: "Tamil",
    url: "https://vidcdn.vidgyor.com/thanthi-origin/live/chunks.m3u8",
    program: "Thanthi Headlines & Daily Express"
  },
  {
    id: "ndtv-24x7",
    name: "NDTV 24x7 HD",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/NDTV_logo.svg/512px-NDTV_logo.svg.png",
    group: "News",
    country: "IN",
    language: "English",
    url: "https://ndtv24x7elemarchana.akamaized.net/hls/live/2003678/ndtv24x7/master.m3u8",
    program: "The World 24x7 & Left Right & Centre"
  },
  {
    id: "india-today",
    name: "India Today",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/India_Today_logo.svg/512px-India_Today_logo.svg.png",
    group: "News",
    country: "IN",
    language: "English",
    url: "https://feeds.intoday.in/hltapps/api/master.m3u8",
    program: "News Today with Rajdeep Sardesai"
  },
  {
    id: "wion-news",
    name: "WION News Live",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b3/WION_logo.svg/512px-WION_logo.svg.png",
    group: "News",
    country: "IN",
    language: "English",
    url: "https://wionnews-live.akamaized.net/hls/live/2034033/wion/master.m3u8",
    program: "Gravitas & Global Perspectives"
  },
  {
    id: "nasa-tv",
    name: "NASA TV HD",
    logo: "https://images.nasa.gov/images/nasa_logo-large.ee51e220.png",
    group: "Science",
    country: "US",
    language: "English",
    url: "https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8",
    program: "ISS Live Stream & Artemis Mission Briefing"
  },
  {
    id: "sky-news",
    name: "Sky News Global",
    logo: "https://news.sky.com/assets/sky-news-logo.png",
    group: "News",
    country: "UK",
    language: "English",
    url: "https://skynews-live.edgesuite.net/hls/live/2027209/skynews_live/master.m3u8",
    program: "Sky News at Ten & Global World Desk"
  },
  {
    id: "bloomberg-tv",
    name: "Bloomberg Quicktake",
    logo: "https://assets.bwbx.io/s3/javelin/public/hub/images/favicon-black-32x32.png",
    group: "News",
    country: "US",
    language: "English",
    url: "https://bloomberg-p2p.akamaized.net/hls/live/2003299/quicktake/master.m3u8",
    program: "Markets Today & Global Economics"
  },
  {
    id: "france24-en",
    name: "France 24 English",
    logo: "https://static.france24.com/meta_og_twcards/F24_TW.png",
    group: "News",
    country: "FR",
    language: "English",
    url: "https://static.france24.com/live/F24_EN_LO_HLS/live_tv.m3u8",
    program: "Live International News & Perspectives"
  },
  {
    id: "dw-english",
    name: "DW English",
    logo: "https://www.dw.com/manifest-icons/icon-192x192.png",
    group: "News",
    country: "DE",
    language: "English",
    url: "https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8",
    program: "DW News Live & Journal Report"
  },
  {
    id: "al-jazeera-en",
    name: "Al Jazeera English",
    logo: "https://www.aljazeera.com/favicon_aje.ico",
    group: "News",
    country: "GLOBAL",
    language: "English",
    url: "https://live-hls-web-aje.getaj.net/AJE/01.m3u8",
    program: "Newshour Worldwide & Documentaries"
  },
  {
    id: "redbull-tv",
    name: "Red Bull TV Live",
    logo: "https://www.redbull.com/v3/resources/images/favicons/favicon-196x196.png",
    group: "Sports",
    country: "GLOBAL",
    language: "English",
    url: "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8",
    program: "Extreme Action Sports & F1 Highlights"
  },
  {
    id: "euronews-en",
    name: "Euronews World",
    logo: "https://www.euronews.com/favicon-192x192.png",
    group: "News",
    country: "GLOBAL",
    language: "English",
    url: "https://rakuten-euronews-1-gb.samsung.wurl.tv/playlist.m3u8",
    program: "European Headline Edition"
  }
];

export function getOrGenerateRoomId(): string {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('remote')) {
    return urlParams.get('remote')!;
  }
  let stored = localStorage.getItem('quantum_iptv_room');
  if (!stored) {
    stored = 'ROOM-' + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem('quantum_iptv_room', stored);
  }
  return stored;
}

export interface State {
  channels: Channel[];
  filteredChannels: Channel[];
  currentChannelIndex: number;
  favorites: string[];
  offlineChannels: Set<string>;
  roomId: string;
  isTheaterFullscreen: boolean;
  aspectIndex: number;
  aspectModes: string[];
  aspectLabels: string[];
  isRemoteClient: boolean;
  remoteLimit: number;
  remoteActiveCategory: string;
  hideOfflineFeeds: boolean;
  lastXtreamHost?: string;
  lastXtreamUser?: string;
  lastXtreamPass?: string;
}

export const state: State = {
  channels: [...DEFAULT_PRESET_CHANNELS],
  filteredChannels: [...DEFAULT_PRESET_CHANNELS],
  currentChannelIndex: 0,
  favorites: JSON.parse(localStorage.getItem('quantum_iptv_favs') || '[]'),
  offlineChannels: new Set<string>(),
  roomId: getOrGenerateRoomId(),
  isTheaterFullscreen: false,
  aspectIndex: 0,
  aspectModes: ['object-contain', 'object-cover', 'object-fill'],
  aspectLabels: ['16:9', 'Fill', 'Stretch'],
  isRemoteClient: false,
  remoteLimit: 60,
  remoteActiveCategory: 'ALL',
  hideOfflineFeeds: false
};

// Global reference for inline legacy onclick handlers
(window as any).state = state;
(window as any).FALLBACK_LOGO = FALLBACK_LOGO;
(window as any).handleLogoError = handleLogoError;
