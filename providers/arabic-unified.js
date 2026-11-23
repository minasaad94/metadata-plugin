/**
 * Nuvio Direct Plugin v4.0.0 — Fast & Accurate Universal Hub
 *
 * Key Upgrades over v3:
 *  - Token-Indexed Fast Matching: Instant O(1) lookup by TMDB ID & Exact Title, plus inverted token index
 *    so fuzzy matching only checks a tiny candidate shortlist instead of scanning 20,000+ items.
 *  - ArabCinemeta Metadata Fallback: Optionally queries ArabCinemeta (or any meta addon) to enrich
 *    Arabic titles & resolve missing IMDb/TMDB IDs.
 *  - Improved Normalization: Handles Arabic-Indic digits (٠-٩), Roman numerals (II/III), diacritics,
 *    Franco-Arab, Egyptian/Levantine transliteration, and noisy stream tags without losing sequel numbers.
 *  - Stream Result Cache + Tight Timeouts: Prevents slow external servers from lagging Nuvio.
 *  - All 5 Plugin Types Retained: "stremio", "xtream", "m3u", "api", "custom".
 */

const CONFIG = {
  // 1. Required: Free TMDB API Key from https://www.themoviedb.org/settings/api
  TMDB_API_KEY: "YOUR_TMDB_API_KEY",

  // 2. Optional: Metadata Fallback Addons (e.g., ArabCinemeta)
  // Used to enrich Arabic titles or resolve IDs when TMDB is incomplete.
  META_ADDONS: [
    // {
    //   name: "Arab Cinemeta",
    //   enabled: true,
    //   url: "https://your-arab-cinemeta-link.com/manifest.json",
    //   headers: {}
    // }
  ],

  // 3. Performance & Accuracy Tuning
  META_CACHE_TTL_MS: 24 * 60 * 60 * 1000,   // 24 hours metadata cache
  LIST_CACHE_TTL_MS: 6 * 60 * 60 * 1000,    // 6 hours Xtream / M3U index cache
  STREAM_CACHE_TTL_MS: 10 * 60 * 1000,      // 10 minutes final streams cache
  FETCH_TIMEOUT_MS: 5500,                   // 5.5 seconds max per external addon
  LIST_FETCH_TIMEOUT_MS: 12000,             // 12 seconds max for large Xtream/M3U lists
  FUZZY_THRESHOLD: 0.80,                    // Stricter accuracy (0.0 - 1.0)
  YEAR_TOLERANCE: 1                         // Allow +/- 1 year release difference
};

/**
 * ============================================================================
 * PLUGINS REGISTRY — ADD ALL YOUR EXTERNAL ADDONS & SOURCES HERE
 * ============================================================================
 * Set enabled: true on any source you want active. Duplicate any block to add more.
 */
const PLUGINS = [
  // [TYPE 1] External Stremio Addon (IPTV Server Addon, Arab Addons, etc.)
  {
    type: "stremio",
    name: "My IPTV Addon",
    enabled: false,
    // Paste the full manifest URL or base URL (tokens/config segments are preserved automatically)
    url: "https://your-iptv-addon.vercel.app/manifest.json",
    // "auto" tries IMDb (tt...) then TMDB (tmdb:...) — fixes ArabCinemeta mismatches
    idMode: "auto",
    // Set true ONLY for addons that use internal IDs instead of tt... (searches their catalog by Arabic/Franco/English)
    catalogFallback: true,
    timeoutMs: 6500,
    headers: {}
  },

  // [TYPE 1 - Example B] Public / Torrent Stremio Addon
  {
    type: "stremio",
    name: "Torrentio",
    enabled: false,
    url: "https://torrentio.strem.fun/manifest.json",
    idMode: "imdb",
    catalogFallback: false,
    timeoutMs: 5000,
    headers: {}
  },

  // [TYPE 2] Direct Xtream Codes IPTV / VOD Server (Movies + Series)
  {
    type: "xtream",
    name: "Xtream VOD",
    enabled: false,
    host: "http://your-xtream-host:8080", // No trailing slash
    username: "YOUR_USERNAME",
    password: "YOUR_PASSWORD"
  },

  // [TYPE 3] Direct M3U / M3U8 VOD Playlist URL
  {
    type: "m3u",
    name: "My M3U Playlist",
    enabled: false,
    url: "https://example.com/playlist.m3u",
    headers: {}
  },

  // [TYPE 4] Generic Custom JSON / REST Search API
  {
    type: "api",
    name: "Custom Arabic API",
    enabled: false,
    // Supported placeholders: {query}, {imdb}, {tmdb}, {type}, {season}, {episode}, {year}
    searchUrl: "https://your-api.com/search?q={query}",
    itemsPath: "results", // Dot-path to array in JSON (use "" if root is already an array)
    fields: {
      title: "title",
      year: "year",
      url: "streamUrl",
      quality: "quality"
    },
    headers: {}
  },

  // [TYPE 5] Custom JS Scraper / Wrapped Nuvio Plugin
  {
    type: "custom",
    name: "Custom JS Scraper",
    enabled: false,
    async search(meta, helpers) {
      // Return array of: { name, title, url, quality, headers? }
      return [];
    }
  }
];

// Manual aliases for rare/old Arabic movies & series
const MANUAL_ALIASES = {
  "283552": ["الفيل الازرق", "el feel el azraq", "el fil el azra2", "the blue elephant"],
  "tt3461252": ["الفيل الازرق", "el feel el azraq", "el fil el azra2", "the blue elephant"],
  "615666": ["الفيل الازرق 2", "el feel el azraq 2", "the blue elephant 2"],
  "tt9701940": ["الفيل الازرق 2", "el feel el azraq 2", "the blue elephant 2"],
  "396535": ["ولاد رزق", "welad rizk", "wlad rizk", "sons of rizk"],
  "tt4896340": ["ولاد رزق", "welad rizk", "wlad rizk", "sons of rizk"]
};

// ============================================================================
// INTERNAL FAST ENGINE (No edits needed below this line)
// ============================================================================

const metaCache = new Map();
const listCache = new Map();
const manifestCache = new Map();
const streamCache = new Map();

const STOP_WORDS = new Set(["the", "el", "al", "of", "and", "in", "a", "an", "في", "من", "على", "عن", "و"]);

function cleanBaseUrl(rawUrl) {
  return String(rawUrl || "").trim().replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, controller ? { ...options, signal: controller.signal } : options);
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json", ...headers } }, timeoutMs);
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Normalize Arabic, Latin, Arabic-Indic digits & Roman numerals
 */
function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ـ]/g, "")
    .replace(/\biii\b/gi, "3")
    .replace(/\bii\b/gi, "2")
    .replace(/\biv\b/gi, "4")
    .replace(/[^\u0621-\u064Aa-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function generateTranslitVariants(arabicText) {
  const norm = normalizeText(arabicText);
  if (!norm || !/[\u0621-\u064A]/.test(norm)) return [];

  const francoMap = {
    'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'g', 'ح': '7',
    'خ': '5', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's',
    'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': '3',
    'غ': 'gh', 'ف': 'f', 'ق': '2', 'ك': 'k', 'ل': 'l', 'م': 'm',
    'ن': 'n', 'ه': 'h', 'و': 'o', 'ي': 'y', ' ': ' '
  };
  const englishMap = { ...francoMap, 'ح': 'h', 'خ': 'kh', 'ع': 'a', 'ق': 'q', 'ج': 'g', 'و': 'w', 'ي': 'i' };
  const levantineMap = { ...englishMap, 'ج': 'j', 'ق': 'k', 'و': 'u' };
  const mapChars = (str, dict) => str.split("").map(c => dict[c] ?? c).join("");

  return [
    mapChars(norm, francoMap),
    mapChars(norm, englishMap),
    mapChars(norm.replace(/\bال/g, "el "), englishMap),
    mapChars(norm.replace(/\bال/g, "al "), levantineMap),
    mapChars(norm.replace(/\bال/g, "el "), francoMap)
  ].map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function cleanNoisyTitle(rawTitle) {
  if (!rawTitle) return { title: "", year: null };
  const str = String(rawTitle);
  const yearMatch = str.match(/(?:\(|\[|\b)(19\d{2}|20\d{2})(?:\)|\]|\b)/);
  const year = yearMatch ? yearMatch[1] : null;

  const cleaned = str
    .replace(/^([A-Z0-9]{2,8}\s*[\|\-:\u2503]\s*)+/i, "")
    .replace(/[\(\[\{].*?[\)\]\}]/g, " ")
    .replace(/\b(4k|2160p|uhd|fhd|hd|sd|cam|ts|1080p|720p|480p|web-?dl|webrip|bluray|brrip|hdr10?|dv|dolby|atmos|h264|h265|hevc|x264|x265|aac|ddp5\.1|arabic|ar|egy|egypt|multi|dubbed|subbed|sub)\b/gi, " ")
    .replace(/(مترجم|مدبلج|فيلم|مسلسل|حصريا|كامل|جودة|عالية|نسخة|اصلية|اونلاين)/g, " ")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title: normalizeText(cleaned), year };
}

function extractTokens(normText) {
  if (!normText) return [];
  return normText
    .split(" ")
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function fuzzyMatchScore(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / ((s1.length - 1) + (s2.length - 1));
}

function isYearCompatible(candidateYear, targetYear) {
  if (!targetYear || !candidateYear) return true;
  const diff = Math.abs(parseInt(targetYear, 10) - parseInt(candidateYear, 10));
  return Number.isNaN(diff) || diff <= CONFIG.YEAR_TOLERANCE;
}

function bestVariantScore(normCandidate, candidateYear, variants, targetYear) {
  if (!normCandidate || !isYearCompatible(candidateYear, targetYear)) return 0;
  let best = 0;
  for (const v of variants) {
    if (normCandidate === v) return 1;
    const score = fuzzyMatchScore(normCandidate, v);
    if (score > best) best = score;
    if (best >= 0.96) return best;
  }
  return best;
}

function isTitleMatch(normCandidate, candidateYear, variants, targetYear) {
  return bestVariantScore(normCandidate, candidateYear, variants, targetYear) >= CONFIG.FUZZY_THRESHOLD;
}

function detectQuality(text) {
  const m = String(text || "").match(/\b(4k|2160p|1080p|fhd|720p|480p|hd|sd)\b/i);
  if (!m) return "HD";
  const q = m[1].toUpperCase();
  if (q === "2160P") return "4K";
  if (q === "FHD") return "1080p";
  return q;
}

function getByPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

/**
 * Build a Fast Inverted Index for large Xtream / M3U lists
 */
function buildFastIndex(entries) {
  const byTmdb = new Map();
  const byExact = new Map();
  const byToken = new Map();

  for (const entry of entries) {
    if (entry.tmdb) {
      if (!byTmdb.has(entry.tmdb)) byTmdb.set(entry.tmdb, []);
      byTmdb.get(entry.tmdb).push(entry);
    }
    if (entry.norm) {
      if (!byExact.has(entry.norm)) byExact.set(entry.norm, []);
      byExact.get(entry.norm).push(entry);

      const tokens = extractTokens(entry.norm);
      for (const tok of tokens) {
        let bucket = byToken.get(tok);
        if (!bucket) {
          bucket = [];
          byToken.set(tok, bucket);
        }
        bucket.push(entry);
      }
    }
  }

  return { timestamp: Date.now(), byTmdb, byExact, byToken, list: entries };
}

/**
 * Query a Fast Index in O(1) -> Token Shortlist -> Ranked Fuzzy
 */
function searchFastIndex(index, meta, maxResults = 6) {
  const results = [];
  const seenIds = new Set();
  const addEntry = (e) => {
    const key = e.id ?? e.url;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    results.push(e);
  };

  // 1. Instant TMDB ID match
  if (meta.tmdbId && index.byTmdb.has(meta.tmdbId)) {
    index.byTmdb.get(meta.tmdbId).forEach(addEntry);
    if (results.length > 0) return results.slice(0, maxResults);
  }

  // 2. Instant Exact Normalized Title match
  for (const v of meta.variants) {
    if (index.byExact.has(v)) {
      for (const e of index.byExact.get(v)) {
        if (isYearCompatible(e.year, meta.year)) addEntry(e);
      }
    }
  }
  if (results.length > 0) return results.slice(0, maxResults);

  // 3. Token Shortlist (only evaluates entries sharing at least one significant word)
  const candidates = new Set();
  for (const v of meta.variants) {
    for (const tok of extractTokens(v)) {
      const bucket = index.byToken.get(tok);
      if (bucket && bucket.length <= 400) {
        for (const e of bucket) candidates.add(e);
      }
    }
  }

  const scored = [];
  for (const entry of candidates) {
    const score = bestVariantScore(entry.norm, entry.year, meta.variants, meta.year);
    if (score >= CONFIG.FUZZY_THRESHOLD) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, maxResults)) addEntry(item.entry);
  return results;
}

/**
 * Bidirectional Canonical ID Resolver (TMDB <-> IMDb + Optional ArabCinemeta Fallback)
 */
async function resolveCanonicalMeta(rawId, mediaType, season, episode) {
  const idStr = String(rawId || "").trim();
  const endpointType = (mediaType === "series" || mediaType === "tv") ? "tv" : "movie";
  const stremioType = endpointType === "tv" ? "series" : "movie";
  const cacheKey = `${endpointType}:${idStr}`;

  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.META_CACHE_TTL_MS) {
    return { ...cached.data, season, episode };
  }

  let tmdbId = null;
  let imdbId = null;
  let year = null;
  const variants = new Set();
  const rawQueries = new Set();

  const addTitle = (t, isPrimary = false) => {
    if (!t) return;
    const trimmed = String(t).trim();
    if (!trimmed) return;
    if (isPrimary) rawQueries.add(trimmed);
    const norm = normalizeText(trimmed);
    if (norm) variants.add(norm);
    generateTranslitVariants(trimmed).forEach(v => variants.add(v));
  };

  if (idStr.startsWith("tt")) {
    imdbId = idStr;
  } else {
    tmdbId = idStr.replace(/^tmdb:/i, "");
  }

  // Step 1: TMDB Resolution
  if (CONFIG.TMDB_API_KEY && CONFIG.TMDB_API_KEY !== "YOUR_TMDB_API_KEY") {
    if (!tmdbId && imdbId) {
      const findData = await fetchJson(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${CONFIG.TMDB_API_KEY}&external_source=imdb_id`
      );
      const match = endpointType === "tv"
        ? (findData?.tv_results?.[0] || findData?.movie_results?.[0])
        : (findData?.movie_results?.[0] || findData?.tv_results?.[0]);
      if (match?.id) tmdbId = String(match.id);
    }

    if (tmdbId) {
      const data = await fetchJson(
        `https://api.themoviedb.org/3/${endpointType}/${tmdbId}?api_key=${CONFIG.TMDB_API_KEY}&append_to_response=alternative_titles,translations,external_ids`
      );
      if (data) {
        year = (data.release_date || data.first_air_date || "").slice(0, 4) || null;
        imdbId = imdbId || data.external_ids?.imdb_id || data.imdb_id || null;

        addTitle(data.original_title || data.original_name, true);
        addTitle(data.title || data.name, true);

        const altList = data.alternative_titles?.titles || data.alternative_titles?.results || [];
        altList.forEach(item => addTitle(item.title, false));

        const translations = data.translations?.translations || [];
        translations
          .filter(t => t.iso_639_1 === "ar" || t.iso_639_1 === "en")
          .forEach(t => addTitle(t.data?.title || t.data?.name, true));
      }
    }
  }

  // Step 2: Optional Meta Addon Fallback (e.g., ArabCinemeta) if missing Arabic title or IMDb ID
  const activeMetaAddons = (CONFIG.META_ADDONS || []).filter(a => a && a.enabled && a.url);
  if (activeMetaAddons.length > 0 && (!imdbId || rawQueries.size === 0)) {
    const lookupId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : idStr);
    const metaJobs = activeMetaAddons.map(a =>
      fetchJson(`${cleanBaseUrl(a.url)}/meta/${stremioType}/${encodeURIComponent(lookupId)}.json`, a.headers || {}, 4000)
    );
    const metaResults = await Promise.allSettled(metaJobs);
    for (const r of metaResults) {
      const item = r.status === "fulfilled" ? r.value?.meta : null;
      if (!item) continue;
      if (!imdbId && typeof item.imdb_id === "string" && item.imdb_id.startsWith("tt")) {
        imdbId = item.imdb_id;
      }
      if (!year && item.releaseInfo) {
        const m = String(item.releaseInfo).match(/\b(19\d{2}|20\d{2})\b/);
        if (m) year = m[1];
      }
      addTitle(item.name, true);
      if (Array.isArray(item.aliases)) item.aliases.forEach(al => addTitle(al, false));
    }
  }

  // Step 3: Manual Aliases
  if (tmdbId && MANUAL_ALIASES[tmdbId]) {
    MANUAL_ALIASES[tmdbId].forEach(t => addTitle(t, true));
  }
  if (imdbId && MANUAL_ALIASES[imdbId]) {
    MANUAL_ALIASES[imdbId].forEach(t => addTitle(t, true));
  }

  const baseMeta = {
    tmdbId,
    imdbId,
    year,
    endpointType,
    rawQueries: Array.from(rawQueries).filter(Boolean),
    variants: Array.from(variants).filter(Boolean)
  };

  metaCache.set(cacheKey, { timestamp: Date.now(), data: baseMeta });
  return { ...baseMeta, season, episode };
}

// ============================================================================
// ADAPTER 1: EXTERNAL STREMIO ADDON (Direct ID + Catalog Fallback)
// ============================================================================
async function fetchStremioStreamsById(baseUrl, stremioType, targetId, addonName, headers, timeoutMs) {
  const data = await fetchJson(
    `${baseUrl}/stream/${stremioType}/${encodeURIComponent(targetId)}.json`,
    headers || {},
    timeoutMs || CONFIG.FETCH_TIMEOUT_MS
  );
  if (!data || !Array.isArray(data.streams)) return [];

  return data.streams
    .filter(s => s.url || s.infoHash)
    .map(s => ({
      name: `${addonName}${s.name ? " - " + s.name : ""}`,
      title: s.title || s.description || s.name || "Stream",
      url: s.url || `magnet:?xt=urn:btih:${s.infoHash}`,
      quality: detectQuality(s.title || s.name),
      headers: s.behaviorHints?.proxyHeaders?.request || headers || {}
    }));
}

async function runStremioPlugin(plugin, meta) {
  const baseUrl = cleanBaseUrl(plugin.url);
  if (!baseUrl) return [];

  const timeoutMs = plugin.timeoutMs || CONFIG.FETCH_TIMEOUT_MS;
  const stremioType = meta.endpointType === "tv" ? "series" : "movie";
  const formatId = (id) => (stremioType === "series" && meta.season != null && meta.episode != null)
    ? `${id}:${meta.season}:${meta.episode}`
    : id;

  const idsToTry = [];
  const mode = plugin.idMode || "auto";
  if ((mode === "imdb" || mode === "auto") && meta.imdbId) idsToTry.push(formatId(meta.imdbId));
  if ((mode === "tmdb" || mode === "auto") && meta.tmdbId) idsToTry.push(formatId(`tmdb:${meta.tmdbId}`));

  // Try canonical IDs in parallel if "auto" for lower latency
  if (idsToTry.length > 0) {
    const idChecks = await Promise.allSettled(
      idsToTry.map(tid => fetchStremioStreamsById(baseUrl, stremioType, tid, plugin.name, plugin.headers, timeoutMs))
    );
    const directStreams = [];
    for (const r of idChecks) {
      if (r.status === "fulfilled" && r.value.length > 0) directStreams.push(...r.value);
    }
    if (directStreams.length > 0) return directStreams;
  }

  // Catalog Search Fallback (for IPTV / Arabic addons with custom internal IDs)
  if (!plugin.catalogFallback || meta.rawQueries.length === 0) return [];

  let manifest = manifestCache.get(baseUrl);
  if (!manifest) {
    manifest = await fetchJson(`${baseUrl}/manifest.json`, plugin.headers || {}, timeoutMs);
    if (!manifest) return [];
    manifestCache.set(baseUrl, manifest);
  }

  const searchableCatalogs = (manifest.catalogs || []).filter(c =>
    c.type === stremioType &&
    Array.isArray(c.extra) &&
    c.extra.some(e => e.name === "search")
  );
  if (searchableCatalogs.length === 0) return [];

  const searchTerms = meta.rawQueries.slice(0, 3);
  const streams = [];

  for (const cat of searchableCatalogs.slice(0, 2)) {
    const searchJobs = searchTerms.map(term =>
      fetchJson(
        `${baseUrl}/catalog/${stremioType}/${encodeURIComponent(cat.id)}/search=${encodeURIComponent(term)}.json`,
        plugin.headers || {},
        timeoutMs
      )
    );
    const searchResults = await Promise.allSettled(searchJobs);
    const matchedIds = new Set();

    for (const r of searchResults) {
      const metas = r.status === "fulfilled" && Array.isArray(r.value?.metas) ? r.value.metas : [];
      for (const item of metas) {
        const { title, year } = cleanNoisyTitle(item.name);
        const itemYear = item.releaseInfo ? String(item.releaseInfo).slice(0, 4) : year;
        if (isTitleMatch(title, itemYear, meta.variants, meta.year)) {
          matchedIds.add(formatId(item.id));
        }
      }
    }

    if (matchedIds.size > 0) {
      const streamJobs = Array.from(matchedIds).slice(0, 3).map(mid =>
        fetchStremioStreamsById(baseUrl, stremioType, mid, plugin.name, plugin.headers, timeoutMs)
      );
      const fetched = await Promise.allSettled(streamJobs);
      for (const f of fetched) {
        if (f.status === "fulfilled") streams.push(...f.value);
      }
      if (streams.length > 0) return streams;
    }
  }

  return streams;
}

// ============================================================================
// ADAPTER 2: XTREAM CODES IPTV / VOD (Token-Indexed Fast Search)
// ============================================================================
async function loadXtreamIndex(plugin, endpointType) {
  const host = String(plugin.host || "").replace(/\/+$/, "");
  const cacheKey = `xtream:${host}:${plugin.username}:${endpointType}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.LIST_CACHE_TTL_MS) return cached;

  const action = endpointType === "tv" ? "get_series" : "get_vod_streams";
  const url = `${host}/player_api.php?username=${encodeURIComponent(plugin.username)}&password=${encodeURIComponent(plugin.password)}&action=${action}`;

  const rawList = await fetchJson(url, {}, CONFIG.LIST_FETCH_TIMEOUT_MS);
  if (!Array.isArray(rawList)) return buildFastIndex([]);

  const entries = rawList.map(item => {
    const rawName = item.name || "";
    const { title, year } = cleanNoisyTitle(rawName);
    const tmdb = item.tmdb ? String(item.tmdb).trim() : null;
    return endpointType === "tv"
      ? { id: item.series_id, name: rawName, norm: title, year, tmdb }
      : { id: item.stream_id, name: rawName, norm: title, year, tmdb, ext: item.container_extension || "mp4" };
  });

  const index = buildFastIndex(entries);
  listCache.set(cacheKey, index);
  return index;
}

async function runXtreamPlugin(plugin, meta) {
  const host = String(plugin.host || "").replace(/\/+$/, "");
  if (!host || host.includes("your-xtream-host")) return [];

  const index = await loadXtreamIndex(plugin, meta.endpointType);
  const matches = searchFastIndex(index, meta, 6);
  if (matches.length === 0) return [];

  const streams = [];
  if (meta.endpointType === "movie") {
    for (const entry of matches) {
      streams.push({
        name: plugin.name || "Xtream VOD",
        title: entry.name,
        url: `${host}/movie/${plugin.username}/${plugin.password}/${entry.id}.${entry.ext}`,
        quality: detectQuality(entry.name)
      });
    }
  } else if (meta.endpointType === "tv" && meta.season != null && meta.episode != null) {
    const sNum = String(parseInt(meta.season, 10));
    const eNum = parseInt(meta.episode, 10);

    const infoJobs = matches.slice(0, 3).map(async (entry) => {
      const infoUrl = `${host}/player_api.php?username=${encodeURIComponent(plugin.username)}&password=${encodeURIComponent(plugin.password)}&action=get_series_info&series_id=${entry.id}`;
      const info = await fetchJson(infoUrl);
      const seasonEps = info?.episodes?.[sNum] || [];
      const ep = seasonEps.find(x => parseInt(x.episode_num, 10) === eNum);
      if (!ep) return null;
      const ext = ep.container_extension || "mp4";
      return {
        name: plugin.name || "Xtream Series",
        title: `${entry.name} - S${sNum}E${eNum}`,
        url: `${host}/series/${plugin.username}/${plugin.password}/${ep.id}.${ext}`,
        quality: detectQuality(ep.title || entry.name)
      };
    });

    const settled = await Promise.allSettled(infoJobs);
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) streams.push(r.value);
    }
  }
  return streams;
}

// ============================================================================
// ADAPTER 3: M3U / M3U8 PLAYLIST (Token-Indexed Fast Search)
// ============================================================================
async function loadM3uIndex(plugin) {
  const cacheKey = `m3u:${plugin.url}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.LIST_CACHE_TTL_MS) return cached;

  const res = await fetchWithTimeout(plugin.url, { headers: plugin.headers || {} }, CONFIG.LIST_FETCH_TIMEOUT_MS);
  if (!res || !res.ok) return buildFastIndex([]);
  const text = await res.text();
  const lines = text.split(/\r?\n/);

  const entries = [];
  let currentName = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const commaIdx = line.lastIndexOf(",");
      currentName = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : "";
    } else if (!line.startsWith("#") && currentName !== null) {
      const { title, year } = cleanNoisyTitle(currentName);
      entries.push({ name: currentName, norm: title, year, url: line });
      currentName = null;
    }
  }

  const index = buildFastIndex(entries);
  listCache.set(cacheKey, index);
  return index;
}

async function runM3uPlugin(plugin, meta) {
  if (!plugin.url) return [];
  const index = await loadM3uIndex(plugin);
  const matches = searchFastIndex(index, meta, 12);
  const epRegex = (meta.endpointType === "tv" && meta.season != null && meta.episode != null)
    ? new RegExp(`s0*${meta.season}\\s*e0*${meta.episode}\\b`, "i")
    : null;

  return matches
    .filter(e => !epRegex || epRegex.test(e.name))
    .slice(0, 6)
    .map(e => ({
      name: plugin.name || "M3U",
      title: e.name,
      url: e.url,
      quality: detectQuality(e.name),
      headers: plugin.headers || {}
    }));
}

// ============================================================================
// ADAPTER 4: GENERIC JSON / REST API
// ============================================================================
async function runApiPlugin(plugin, meta) {
  if (!plugin.searchUrl) return [];
  const queries = plugin.searchUrl.includes("{query}") ? meta.rawQueries.slice(0, 3) : [""];
  const streams = [];

  for (const q of queries) {
    const finalUrl = plugin.searchUrl
      .replace(/\{query\}/g, encodeURIComponent(q))
      .replace(/\{imdb\}/g, encodeURIComponent(meta.imdbId || ""))
      .replace(/\{tmdb\}/g, encodeURIComponent(meta.tmdbId || ""))
      .replace(/\{type\}/g, encodeURIComponent(meta.endpointType))
      .replace(/\{season\}/g, encodeURIComponent(meta.season ?? ""))
      .replace(/\{episode\}/g, encodeURIComponent(meta.episode ?? ""))
      .replace(/\{year\}/g, encodeURIComponent(meta.year || ""));

    const json = await fetchJson(finalUrl, plugin.headers || {}, plugin.timeoutMs || CONFIG.FETCH_TIMEOUT_MS);
    const items = getByPath(json, plugin.itemsPath);
    if (!Array.isArray(items)) continue;

    const f = plugin.fields || {};
    for (const item of items) {
      const rawTitle = getByPath(item, f.title || "title");
      const rawYear = getByPath(item, f.year || "year");
      const streamUrl = getByPath(item, f.url || "url");
      const quality = getByPath(item, f.quality || "quality");
      if (!streamUrl) continue;

      const { title, year } = cleanNoisyTitle(rawTitle);
      if (!rawTitle || isTitleMatch(title, rawYear || year, meta.variants, meta.year)) {
        streams.push({
          name: plugin.name || "API",
          title: rawTitle || "Stream",
          url: streamUrl,
          quality: detectQuality(quality || rawTitle),
          headers: plugin.headers || {}
        });
      }
    }
    if (streams.length > 0) break;
  }
  return streams;
}

// ============================================================================
// UNIVERSAL DISPATCHER & NUVIO ENTRY POINT
// ============================================================================
function finalizeStreams(streams) {
  const rank = { "4K": 4, "1080p": 3, "720p": 2, "HD": 1, "480p": 0, "SD": 0 };
  const seen = new Set();
  return streams
    .filter(s => {
      if (!s || !s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .sort((a, b) => (rank[b.quality] || 0) - (rank[a.quality] || 0));
}

async function executePlugin(plugin, meta) {
  const helpers = { fetchWithTimeout, fetchJson, normalizeText, cleanNoisyTitle, isTitleMatch, detectQuality };
  switch (plugin.type) {
    case "stremio": return runStremioPlugin(plugin, meta);
    case "xtream":  return runXtreamPlugin(plugin, meta);
    case "m3u":     return runM3uPlugin(plugin, meta);
    case "api":     return runApiPlugin(plugin, meta);
    case "custom":  return typeof plugin.search === "function" ? plugin.search(meta, helpers) : [];
    default:        return [];
  }
}

async function getStreams(id, mediaType, season, episode) {
  try {
    if (!CONFIG.TMDB_API_KEY || CONFIG.TMDB_API_KEY === "YOUR_TMDB_API_KEY") {
      console.warn("[ArabicUnified v4] Set TMDB_API_KEY in providers/arabic-unified.js");
      return [];
    }

    const reqKey = `${mediaType}:${id}:${season ?? ""}:${episode ?? ""}`;
    const cachedStreams = streamCache.get(reqKey);
    if (cachedStreams && Date.now() - cachedStreams.timestamp < CONFIG.STREAM_CACHE_TTL_MS) {
      return cachedStreams.streams;
    }

    const activePlugins = PLUGINS.filter(p => p && p.enabled);
    if (activePlugins.length === 0) return [];

    const meta = await resolveCanonicalMeta(id, mediaType, season, episode);
    const settled = await Promise.allSettled(activePlugins.map(p => executePlugin(p, meta)));

    const allStreams = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        allStreams.push(...r.value);
      }
    }

    const finalStreams = finalizeStreams(allStreams);
    streamCache.set(reqKey, { timestamp: Date.now(), streams: finalStreams });
    return finalStreams;
  } catch (err) {
    console.error("[ArabicUnified v4] Error:", err.message);
    return [];
  }
}

module.exports = {
  getStreams,
  normalizeText,
  generateTranslitVariants,
  cleanNoisyTitle,
  fuzzyMatchScore
};
