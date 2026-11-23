/**
 * Nuvio Direct Plugin v5.0.0 — Stremio Addons Only (Fast & Clean)
 *
 * Focuses exclusively on unifying external Stremio Addons (IPTV server addons,
 * Arab Cinemeta, Torrentio, etc.) directly inside Nuvio with zero server overhead.
 *
 * Improvements in v5:
 *  - Works out-of-the-box even WITHOUT a TMDB API Key (falls back to public Cinemeta + META_ADDONS).
 *  - Adding a free TMDB API Key unlocks full TMDB <-> IMDb resolution & official Arabic/English alt titles.
 *  - Hermes/QuickJS safe timeout (Promise.race fallback) to prevent Nuvio "Test Error".
 *  - Clean, lightweight code: removed Xtream/M3U/API bloat for faster startup & lower memory.
 */

const CONFIG = {
  // Optional (Recommended): Free TMDB API Key from https://www.themoviedb.org/settings/api
  // Leave empty "" if you don't have one yet — the plugin will use Cinemeta + META_ADDONS automatically.
  TMDB_API_KEY: "",

  // Performance & Matching Controls
  META_CACHE_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  STREAM_CACHE_TTL_MS: 10 * 60 * 1000,    // 10 minutes
  FETCH_TIMEOUT_MS: 6000,                 // 6 seconds max per addon
  FUZZY_THRESHOLD: 0.78,                  // Similarity threshold (0.0 - 1.0)
  YEAR_TOLERANCE: 1                       // Allow +/- 1 year difference
};

/**
 * ============================================================================
 * 1. META ADDONS (Optional — e.g. Arab Cinemeta)
 * Used to enrich Arabic titles & resolve missing IMDb IDs.
 * ============================================================================
 */
const META_ADDONS = [
  {
    name: "Cinemeta",
    enabled: true,
    url: "https://v3-cinemeta.strem.io/manifest.json",
    headers: {}
  }
  // Add Arab Cinemeta below (uncomment and paste your real URL):
  // ,{
  //   name: "Arab Cinemeta",
  //   enabled: true,
  //   url: "https://your-arab-cinemeta-url.com/manifest.json",
  //   headers: {}
  // }
];

/**
 * ============================================================================
 * 2. STREAM ADDONS — PASTE YOUR EXTERNAL STREMIO ADDON LINKS HERE
 * ============================================================================
 * Set enabled: true on every addon you want active.
 */
const STREAM_ADDONS = [
  {
    name: "My IPTV Addon",
    enabled: false, // <-- Change to true after pasting your real URL
    url: "https://your-iptv-addon.vercel.app/manifest.json",
    idMode: "auto",        // Tries IMDb (tt...) & TMDB (tmdb:...) in parallel
    catalogFallback: true, // Searches addon's catalog by Arabic/Franco/English if ID fails
    timeoutMs: 7000,
    headers: {}
  },
  {
    name: "Torrentio",
    enabled: true, // Enabled by default so Nuvio "Test" immediately returns results
    url: "https://torrentio.strem.fun/manifest.json",
    idMode: "imdb",
    catalogFallback: false,
    timeoutMs: 5500,
    headers: {}
  }
];

// Manual aliases for hard-to-match Arabic movies/series (TMDB ID or IMDb ID)
const MANUAL_ALIASES = {
  "283552": ["الفيل الازرق", "el feel el azraq", "el fil el azra2", "the blue elephant"],
  "tt3461252": ["الفيل الازرق", "el feel el azraq", "el fil el azra2", "the blue elephant"],
  "615666": ["الفيل الازرق 2", "el feel el azraq 2", "the blue elephant 2"],
  "tt9701940": ["الفيل الازرق 2", "el feel el azraq 2", "the blue elephant 2"],
  "396535": ["ولاد رزق", "welad rizk", "wlad rizk", "sons of rizk"],
  "tt4896340": ["ولاد رزق", "welad rizk", "wlad rizk", "sons of rizk"]
};

// ============================================================================
// INTERNAL ENGINE (No edits needed below)
// ============================================================================

const metaCache = new Map();
const manifestCache = new Map();
const streamCache = new Map();

function cleanBaseUrl(rawUrl) {
  return String(rawUrl || "").trim().replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
}

/**
 * Runtime-safe JSON fetch with timeout (compatible with Hermes / QuickJS / Node)
 */
async function fetchJson(url, headers = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const fetchPromise = (async () => {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...headers }
      });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  })();
  return Promise.race([fetchPromise, timeoutPromise]);
}

function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
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
  const mapChars = (str, dict) => str.split("").map((c) => dict[c] ?? c).join("");

  return [
    mapChars(norm, francoMap),
    mapChars(norm, englishMap),
    mapChars(norm.replace(/\bال/g, "el "), englishMap),
    mapChars(norm.replace(/\bال/g, "al "), englishMap),
    mapChars(norm.replace(/\bال/g, "el "), francoMap)
  ].map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function cleanNoisyTitle(rawTitle) {
  if (!rawTitle) return { title: "", year: null };
  const str = String(rawTitle);
  const yearMatch = str.match(/(?:\(|\[|\b)(19\d{2}|20\d{2})(?:\)|\]|\b)/);
  const year = yearMatch ? yearMatch[1] : null;

  const cleaned = str
    .replace(/^([A-Z0-9]{2,8}\s*[\|\-:\u2503]\s*)+/i, "")
    .replace(/[\(\[\{].*?[\)\]\}]/g, " ")
    .replace(/\b(4k|2160p|uhd|fhd|hd|sd|cam|ts|1080p|720p|480p|web-?dl|webrip|bluray|brrip|hdr10?|dv|dolby|atmos|h264|h265|hevc|x264|x265|arabic|ar|egy|egypt|multi|dubbed|subbed|sub)\b/gi, " ")
    .replace(/(مترجم|مدبلج|فيلم|مسلسل|حصريا|كامل|جودة|عالية|نسخة|اصلية|اونلاين)/g, " ")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title: normalizeText(cleaned), year };
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

function isTitleMatch(normCandidate, candidateYear, variants, targetYear) {
  if (!normCandidate) return false;
  if (targetYear && candidateYear) {
    const diff = Math.abs(parseInt(targetYear, 10) - parseInt(candidateYear, 10));
    if (!Number.isNaN(diff) && diff > CONFIG.YEAR_TOLERANCE) return false;
  }
  for (const v of variants) {
    if (normCandidate === v || fuzzyMatchScore(normCandidate, v) >= CONFIG.FUZZY_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function detectQuality(text) {
  const m = String(text || "").match(/\b(4k|2160p|1080p|fhd|720p|480p|hd|sd)\b/i);
  if (!m) return "HD";
  const q = m[1].toUpperCase();
  if (q === "2160P") return "4K";
  if (q === "FHD") return "1080p";
  return q;
}

/**
 * Resolve Canonical IDs (TMDB <-> IMDb) & Title Variants
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
    generateTranslitVariants(trimmed).forEach((v) => variants.add(v));
  };

  if (idStr.startsWith("tt")) {
    imdbId = idStr;
  } else {
    tmdbId = idStr.replace(/^tmdb:/i, "");
  }

  // 1. TMDB API (if key is provided)
  const hasTmdbKey = CONFIG.TMDB_API_KEY && CONFIG.TMDB_API_KEY !== "YOUR_TMDB_API_KEY";
  if (hasTmdbKey) {
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
        altList.forEach((item) => addTitle(item.title, false));

        const translations = data.translations?.translations || [];
        translations
          .filter((t) => t.iso_639_1 === "ar" || t.iso_639_1 === "en")
          .forEach((t) => addTitle(t.data?.title || t.data?.name, true));
      }
    }
  }

  // 2. Meta Addons Fallback (Cinemeta / Arab Cinemeta)
  const activeMetaAddons = META_ADDONS.filter((a) => a && a.enabled && a.url);
  if (activeMetaAddons.length > 0 && (!imdbId || rawQueries.size === 0)) {
    const lookupId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : idStr);
    const metaJobs = activeMetaAddons.map((a) =>
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
      if (Array.isArray(item.aliases)) item.aliases.forEach((al) => addTitle(al, false));
    }
  }

  // 3. Manual Aliases
  if (tmdbId && MANUAL_ALIASES[tmdbId]) MANUAL_ALIASES[tmdbId].forEach((t) => addTitle(t, true));
  if (imdbId && MANUAL_ALIASES[imdbId]) MANUAL_ALIASES[imdbId].forEach((t) => addTitle(t, true));

  const baseMeta = {
    tmdbId,
    imdbId,
    year,
    stremioType,
    rawQueries: Array.from(rawQueries).filter(Boolean),
    variants: Array.from(variants).filter(Boolean)
  };

  metaCache.set(cacheKey, { timestamp: Date.now(), data: baseMeta });
  return { ...baseMeta, season, episode };
}

/**
 * Query a single Stremio Stream Addon (Direct ID + Catalog Fallback)
 */
async function fetchStreamsById(baseUrl, stremioType, targetId, addonName, headers, timeoutMs) {
  const data = await fetchJson(
    `${baseUrl}/stream/${stremioType}/${encodeURIComponent(targetId)}.json`,
    headers || {},
    timeoutMs || CONFIG.FETCH_TIMEOUT_MS
  );
  if (!data || !Array.isArray(data.streams)) return [];

  return data.streams
    .filter((s) => s.url || s.infoHash)
    .map((s) => ({
      name: `${addonName}${s.name ? " - " + s.name : ""}`,
      title: s.title || s.description || s.name || "Stream",
      url: s.url || `magnet:?xt=urn:btih:${s.infoHash}`,
      quality: detectQuality(s.title || s.name),
      headers: s.behaviorHints?.proxyHeaders?.request || headers || {}
    }));
}

async function queryAddon(addon, meta) {
  const baseUrl = cleanBaseUrl(addon.url);
  if (!baseUrl) return [];

  const timeoutMs = addon.timeoutMs || CONFIG.FETCH_TIMEOUT_MS;
  const { stremioType } = meta;
  const formatId = (id) => (stremioType === "series" && meta.season != null && meta.episode != null)
    ? `${id}:${meta.season}:${meta.episode}`
    : id;

  // Step 1: Direct Canonical ID lookup (IMDb & TMDB in parallel)
  const idsToTry = [];
  const mode = addon.idMode || "auto";
  if ((mode === "imdb" || mode === "auto") && meta.imdbId) idsToTry.push(formatId(meta.imdbId));
  if ((mode === "tmdb" || mode === "auto") && meta.tmdbId) idsToTry.push(formatId(`tmdb:${meta.tmdbId}`));

  if (idsToTry.length > 0) {
    const checks = await Promise.allSettled(
      idsToTry.map((tid) => fetchStreamsById(baseUrl, stremioType, tid, addon.name, addon.headers, timeoutMs))
    );
    const direct = [];
    for (const r of checks) {
      if (r.status === "fulfilled" && r.value.length > 0) direct.push(...r.value);
    }
    if (direct.length > 0) return direct;
  }

  // Step 2: Catalog Search Fallback (for IPTV / Arabic addons with internal IDs)
  if (!addon.catalogFallback || meta.rawQueries.length === 0) return [];

  let manifest = manifestCache.get(baseUrl);
  if (!manifest) {
    manifest = await fetchJson(`${baseUrl}/manifest.json`, addon.headers || {}, timeoutMs);
    if (!manifest) return [];
    manifestCache.set(baseUrl, manifest);
  }

  const catalogs = (manifest.catalogs || []).filter((c) =>
    c.type === stremioType &&
    Array.isArray(c.extra) &&
    c.extra.some((e) => e.name === "search")
  );
  if (catalogs.length === 0) return [];

  const searchTerms = meta.rawQueries.slice(0, 3);
  const streams = [];

  for (const cat of catalogs.slice(0, 2)) {
    const searchJobs = searchTerms.map((term) =>
      fetchJson(
        `${baseUrl}/catalog/${stremioType}/${encodeURIComponent(cat.id)}/search=${encodeURIComponent(term)}.json`,
        addon.headers || {},
        timeoutMs
      )
    );
    const results = await Promise.allSettled(searchJobs);
    const matchedIds = new Set();

    for (const r of results) {
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
      const streamJobs = Array.from(matchedIds).slice(0, 3).map((mid) =>
        fetchStreamsById(baseUrl, stremioType, mid, addon.name, addon.headers, timeoutMs)
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

function finalizeStreams(streams) {
  const rank = { "4K": 4, "1080p": 3, "720p": 2, "HD": 1, "480p": 0, "SD": 0 };
  const seen = new Set();
  return streams
    .filter((s) => {
      if (!s || !s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .sort((a, b) => (rank[b.quality] || 0) - (rank[a.quality] || 0));
}

/**
 * Main Nuvio Entry Point
 */
async function getStreams(id, mediaType, season, episode) {
  try {
    const reqKey = `${mediaType}:${id}:${season ?? ""}:${episode ?? ""}`;
    const cached = streamCache.get(reqKey);
    if (cached && Date.now() - cached.timestamp < CONFIG.STREAM_CACHE_TTL_MS) {
      return cached.streams;
    }

    const activeAddons = STREAM_ADDONS.filter((a) => a && a.enabled && a.url);
    if (activeAddons.length === 0) return [];

    const meta = await resolveCanonicalMeta(id, mediaType, season, episode);
    const settled = await Promise.allSettled(activeAddons.map((addon) => queryAddon(addon, meta)));

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
    console.error("[ArabicUnified v5] Error:", err && err.message ? err.message : err);
    return [];
  }
}

module.exports = { getStreams };
