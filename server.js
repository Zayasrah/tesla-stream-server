const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7860;
// In an automotive single-driver setting on 512MB RAM, cap concurrent streams to 1 with instant preemption
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_STREAMS || '1', 10);
let currentActiveSession = null;

// Initialize YouTube cookies if provided in environment variable
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim().length > 10) {
  try {
    let raw = process.env.YOUTUBE_COOKIES.trim();
    // Handle literal '\n' escaping often produced by cloud environment variable fields
    if (raw.includes('\\n')) {
      raw = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    }
    fs.writeFileSync(COOKIES_PATH, raw, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    console.log(`✅ Loaded YouTube authentication cookies (${lines} active cookie lines)!`);
  } catch (err) {
    console.error('Failed to write cookies.txt:', err.message);
  }
}

// Direct CDN Stream Map for 100% Unblockable 24/7 Live Broadcasts
const DIRECT_STREAM_MAP = {
  // Makkah Live 24/7 (Saudi Quran TV official Akamai CDN)
  'eC4LfEVxvKg': 'https://cdn-globecast.akamaized.net/live/eds/saudi_quran/hls_roku/index.m3u8',
  // Madinah Live 24/7 (Saudi Sunnah TV official Akamai CDN)
  'Rs7St51oDDc': 'https://cdn-globecast.akamaized.net/live/eds/saudi_sunnah/hls_roku/index.m3u8',
  // Test stream identifier
  'test': 'https://cdn-globecast.akamaized.net/live/eds/saudi_quran/hls_roku/index.m3u8'
};

// Launch BotGuard Proof-of-Origin Token (POT) server on port 4416
let potServerProcess = null;
let isPotServerHealthy = false;
let potRestartAttempts = 0;
const POT_SCRIPT = '/opt/bgutil-provider/build/main.js';

function startPotProvider() {
  if (!fs.existsSync(POT_SCRIPT)) {
    console.log('ℹ️ POT provider script not found at', POT_SCRIPT, '(running in fallback mode)');
    return;
  }
  try {
    console.log('🚀 Spawning BotGuard Proof-of-Origin Token daemon on 127.0.0.1:4416 (memory capped to 96MB)...');
    potServerProcess = spawn('node', ['--max-old-space-size=96', POT_SCRIPT, '--host', '127.0.0.1', '--port', '4416'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    potServerProcess.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[POT Daemon]', msg);
      if (msg.includes('Listening') || msg.includes('4416') || msg.includes('ready') || msg.includes('running')) {
        isPotServerHealthy = true;
      }
    });
    potServerProcess.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[POT Daemon Err]', msg);
    });
    potServerProcess.on('exit', (code) => {
      console.warn(`[POT Daemon] Exited with code ${code}`);
      isPotServerHealthy = false;
      potServerProcess = null;
      if (potRestartAttempts < 2) {
        potRestartAttempts++;
        console.log(`[POT Daemon] Auto-restarting in 4s (attempt ${potRestartAttempts}/2)...`);
        setTimeout(startPotProvider, 4000);
      }
    });

    // Active health ping after 2.5s
    setTimeout(async () => {
      try {
        const ping = await fetch('http://127.0.0.1:4416/ping', { signal: AbortSignal.timeout(1500) });
        if (ping.ok || ping.status < 500) {
          isPotServerHealthy = true;
          console.log('✅ POT Daemon verified active and responsive on 127.0.0.1:4416');
        }
      } catch (e) {
        try {
          const ping2 = await fetch('http://127.0.0.1:4416/', { signal: AbortSignal.timeout(1500) });
          if (ping2.ok || ping2.status < 500) {
            isPotServerHealthy = true;
            console.log('✅ POT Daemon verified active and responsive on 127.0.0.1:4416');
          }
        } catch (e2) {}
      }
    }, 2500);

  } catch (err) {
    console.error('Failed to spawn POT provider:', err.message);
  }
}

startPotProvider();

// High-Performance In-Memory URL Cache for Zero-Wait Video Switching (3-Hour TTL)
const RESOLVED_URL_CACHE = new Map(); // videoId -> { urls: string[], expiresAt: number }

function getCachedStreamUrls(videoId) {
  const cached = RESOLVED_URL_CACHE.get(videoId);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    RESOLVED_URL_CACHE.delete(videoId);
    return null;
  }
  return cached.urls;
}

function cacheStreamUrls(videoId, urls) {
  if (!urls || urls.length === 0) return;
  let expiresAt = Date.now() + 3 * 3600 * 1000; // default 3 hours
  const match = urls[0].match(/[?&]expire=(\d+)/);
  if (match) {
    const expireSec = parseInt(match[1], 10);
    expiresAt = (expireSec * 1000) - (15 * 60 * 1000); // 15min safety margin
  }
  if (RESOLVED_URL_CACHE.size > 50) {
    const oldestKey = RESOLVED_URL_CACHE.keys().next().value;
    RESOLVED_URL_CACHE.delete(oldestKey);
  }
  RESOLVED_URL_CACHE.set(videoId, { urls, expiresAt });
  console.log(`[Cache Stored] Video ${videoId} cached until ${new Date(expiresAt).toLocaleTimeString()}`);
}

// Multi-tier Quality Profiles calibrated for zero-drop real-time streaming on cloud vCPU
const QUALITY_PROFILES = {
  '360p': {
    resolution: '640x360',
    videoBitrate: '600k',
    maxRate: '850k',
    bufSize: '1200k',
    fps: '25',
    gop: '25',
    qmin: '3',
    qmax: '12'
  },
  '480p': {
    resolution: '854x480',
    videoBitrate: '850k',
    maxRate: '1100k',
    bufSize: '1600k',
    fps: '25',
    gop: '25',
    qmin: '3',
    qmax: '14'
  },
  '540p': {
    resolution: '960x540',
    videoBitrate: '1050k',
    maxRate: '1350k',
    bufSize: '1900k',
    fps: '25',
    gop: '25',
    qmin: '4',
    qmax: '16'
  },
  '720p': {
    resolution: '1280x720',
    videoBitrate: '1100k',
    maxRate: '1450k',
    bufSize: '2000k',
    fps: '25',
    gop: '25',
    qmin: '5',
    qmax: '20'
  }
};

let latestStreamTelemetry = { speed: '0x', fps: 0, bitrate: '0k', lastUpdated: 0 };

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  console.log('📦 Serving bundled static frontend web app from', PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
}

let activeStreams = 0;

// Universal YouTube Video Search Proxy (supports native search directly on Render)
async function searchYouTube(query) {
  if (!query || !query.trim()) return [];

  // 1. Direct YouTube Web Search Parser
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ar,en;q=0.9'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      const html = await res.text();
      const m = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
      if (m) {
        const data = JSON.parse(m[1]);
        const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const videos = [];
        for (const section of sections) {
          const items = section.itemSectionRenderer?.contents || [];
          for (const item of items) {
            const v = item.videoRenderer;
            if (v && v.videoId) {
              const title = v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || '';
              const channel = v.ownerText?.runs?.map(r => r.text).join('') || '';
              const duration = v.lengthText?.simpleText || '';
              const views = v.viewCountText?.simpleText || '';
              const thumb = v.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
              videos.push({
                id: v.videoId,
                titleAr: title,
                titleEn: title,
                category: 'recitation',
                reciterName: channel,
                channelName: channel,
                duration: duration,
                qualityBadge: duration ? 'HD' : 'Live',
                thumbnailUrl: thumb,
                views: views
              });
            }
          }
        }
        if (videos.length > 0) {
          return videos.slice(0, 30);
        }
      }
    }
  } catch (err) {
    console.warn('Direct YouTube search scrape failed, falling back:', err.message);
  }

  // 2. High-Resilience Fallback: DuckDuckGo Video Index
  try {
    const tokenRes = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(4000)
    });
    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=([0-9-]+)/) || html.match(/vqd="([0-9-]+)"/);
    if (vqdMatch) {
      const vqd = vqdMatch[1];
      const videoRes = await fetch('https://duckduckgo.com/v.js?l=wt-wt&o=json&q=' + encodeURIComponent(query) + '&vqd=' + vqd, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(4000)
      });
      if (videoRes.ok) {
        const data = await videoRes.json();
        const results = (data.results || [])
          .filter(r => r.content && r.content.includes('youtube.com/watch?v='))
          .map(r => {
            const match = r.content.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
            const id = match ? match[1] : '';
            const title = r.title || '';
            const channel = r.uploader || '';
            const duration = r.duration || '';
            const views = r.statistics?.viewCount ? `${Number(r.statistics.viewCount).toLocaleString()} views` : '';
            const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : (r.images?.large || '');
            return {
              id,
              titleAr: title,
              titleEn: title,
              category: 'recitation',
              reciterName: channel,
              channelName: channel,
              duration: duration,
              qualityBadge: 'HD',
              thumbnailUrl: thumb,
              views: views
            };
          })
          .filter(v => v.id);
        if (results.length > 0) {
          return results.slice(0, 30);
        }
      }
    }
  } catch (err) {
    console.warn('Fallback video scrape failed:', err.message);
  }

  return [];
}

// YouTube Search API endpoint
app.get('/api/youtube-search', async (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  try {
    const videos = await searchYouTube(q);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json(videos);
  } catch (err) {
    return res.status(500).json({ error: err.message, videos: [] });
  }
});

// Health & Probe / Web App root endpoint
app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath) && (!req.headers.accept || req.headers.accept.includes('text/html'))) {
    return res.sendFile(indexPath);
  }
  res.json({
    status: 'online',
    service: 'Tesla In-Motion Canvas Video Stream Server & Web App',
    version: '5.5.4-node22-deno-challenge-solver',
    hasCookies: fs.existsSync(COOKIES_PATH),
    hasPotProvider: fs.existsSync(POT_SCRIPT) && !!potServerProcess && !potServerProcess.killed,
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    supportedQualities: Object.keys(QUALITY_PROFILES),
    streamTelemetry: latestStreamTelemetry,
    instructions: 'Connect via WebSocket: wss://<this-host>/stream?v=<youtubeId>&q=360p'
  });
});

// Helper to sanitize and deduplicate Netscape cookies strictly for YouTube/Google domains
function sanitizeNetscapeCookies(rawText) {
  const lines = rawText.split(/\r?\n/);
  const bestMap = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0].toLowerCase();
    if (
      domain.includes('youtube.com') ||
      domain.includes('google.com') ||
      domain.includes('googlevideo.com') ||
      domain.includes('youtu.be')
    ) {
      const key = `${parts[0]}|${parts[2]}|${parts[5]}`;
      const exp = parseInt(parts[4], 10) || 0;
      if (!bestMap.has(key) || exp >= bestMap.get(key).exp) {
        bestMap.set(key, { exp, line: trimmed });
      }
    }
  }
  if (bestMap.size === 0) return rawText.trim();
  return [
    '# Netscape HTTP Cookie File',
    '# http://curl.haxx.se/rfc/cookie_spec.html',
    ...Array.from(bestMap.values()).map((v) => v.line)
  ].join('\n') + '\n';
}

// Endpoint to save YouTube cookies directly from the web app UI
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
    return res.status(400).json({ error: 'Invalid cookie content' });
  }
  try {
    const sanitized = sanitizeNetscapeCookies(cookies);
    const validLines = sanitized.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    // Guard: Prevent legacy multi-site browser dumps from corrupting clean Incognito cookies
    if (validLines > 60 && process.env.YOUTUBE_COOKIES) {
      return res.status(400).json({
        error: 'Refusing multi-site cookie dump: Server is already protected with clean Incognito cookies via YOUTUBE_COOKIES.'
      });
    }
    fs.writeFileSync(COOKIES_PATH, sanitized, 'utf8');
    console.log(`✅ Cookies sanitized & updated via /cookies API endpoint (${validLines} valid YouTube/Google cookies)!`);
    res.json({ status: 'ok', message: 'Cookies saved successfully', hasCookies: true, validLines });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write cookies: ' + err.message });
  }
});

// Endpoint to reset cookies back to authoritative YOUTUBE_COOKIES environment variable
app.post('/cookies/reset-to-env', (req, res) => {
  if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim().length > 10) {
    try {
      let raw = process.env.YOUTUBE_COOKIES.trim();
      if (raw.includes('\\n')) {
        raw = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
      }
      fs.writeFileSync(COOKIES_PATH, raw, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
      return res.json({ status: 'ok', message: `Reset to ENV cookies (${lines} lines)`, validLines: lines });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  res.status(404).json({ error: 'YOUTUBE_COOKIES environment variable not defined' });
});

// Endpoint to clear YouTube cookies
app.delete('/cookies', (req, res) => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      fs.unlinkSync(COOKIES_PATH);
      console.log('🗑️ Cookies cleared via DELETE /cookies endpoint');
    }
    res.json({ status: 'ok', message: 'Cookies cleared successfully', hasCookies: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear cookies: ' + err.message });
  }
});

app.get('/health', (req, res) => {
  const cookieExists = fs.existsSync(COOKIES_PATH);
  let cookieStats = null;
  if (cookieExists) {
    try {
      const content = fs.readFileSync(COOKIES_PATH, 'utf8');
      const lines = content.split('\n');
      cookieStats = {
        bytes: Buffer.byteLength(content),
        totalLines: lines.length,
        validLines: lines.filter((l) => l.trim() && !l.startsWith('#')).length,
        firstLine: lines[0] ? lines[0].substring(0, 60) : ''
      };
    } catch (e) {
      cookieStats = { error: e.message };
    }
  }

  const mem = process.memoryUsage();
  res.status(200).json({
    status: 'ok',
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024)
    },
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    hasCookies: cookieExists,
    cookieStats,
    streamTelemetry: latestStreamTelemetry,
    hasPotProvider: isPotServerHealthy,
    cachedStreamsCount: RESOLVED_URL_CACHE.size,
    uptime: process.uptime(),
    version: '5.6.0-timeline-seek-and-watch-history'
  });
});

// Diagnostic endpoint
app.get('/diag', async (req, res) => {
  const videoId = req.query.v || 'eC4LfEVxvKg';
  const requestedQuality = req.query.q || '360p';
  const profile = QUALITY_PROFILES[requestedQuality] || QUALITY_PROFILES['360p'];
  const start = Date.now();
  const results = {};

  // Check if it's a direct CDN stream
  if (DIRECT_STREAM_MAP[videoId]) {
    try {
      const cdnRes = await fetch(DIRECT_STREAM_MAP[videoId], { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      return res.json({
        status: 'success',
        type: 'direct_cdn',
        videoId,
        quality: requestedQuality,
        profile,
        cdnStatus: `HTTP ${cdnRes.status}`,
        url: DIRECT_STREAM_MAP[videoId],
        elapsedMs: Date.now() - start
      });
    } catch (e) {
      return res.status(500).json({ error: 'Direct CDN probe failed: ' + e.message });
    }
  }

  // Fast-path: In-memory cached stream URL
  const cachedUrls = getCachedStreamUrls(videoId);
  if (cachedUrls && req.query.fresh !== '1') {
    return res.json({
      status: 'success',
      type: 'cached_fastpath',
      videoId,
      hasCookies: fs.existsSync(COOKIES_PATH),
      elapsedMs: Date.now() - start,
      urlCount: cachedUrls.length,
      sampleUrl: cachedUrls[0].substring(0, 80) + '...'
    });
  }

  // Otherwise test yt-dlp
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const hasCookies = fs.existsSync(COOKIES_PATH);
  let isFullAuthCookie = false;
  if (hasCookies) {
    try {
      const c = fs.readFileSync(COOKIES_PATH, 'utf8');
      isFullAuthCookie = c.includes('LOGIN_INFO') || c.includes('__Secure-3PSID') || c.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length > 10;
    } catch {}
  }
  const potArgs = (isPotServerHealthy && req.query.nopot !== '1')
    ? [
        '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
      ]
    : [];
  const clientArgs = req.query.client
    ? ['--extractor-args', `youtube:player_client=${req.query.client}`]
    : [];
  const ytdlpArgs = [
    '-v',
    '-4',
    '--socket-timeout', '15',
    '--cache-dir', '/tmp/ytdlp_cache',
    '--no-warnings',
    '--js-runtimes', 'node',
    ...potArgs,
    ...clientArgs,
    '-f', req.query.f || '18/b[ext=mp4]/b/bestvideo[height<=720]+bestaudio/best*',
    '-g',
    youtubeUrl
  ];

  if (hasCookies && req.query.nocookies !== '1') {
    ytdlpArgs.splice(1, 0, '--cookies', COOKIES_PATH);
  }

  const ytdlp = spawn('python3', ['-m', 'yt_dlp', ...ytdlpArgs], {
    env: {
      ...process.env,
      HOME: '/home/node',
      PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
      PYTHONUNBUFFERED: '1'
    }
  });

  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', (d) => { stdout += d.toString(); });
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    try { ytdlp.kill('SIGKILL'); } catch (e) {}
    res.status(504).json({
      error: 'Timeout after 60s',
      stdout: stdout.slice(0, 1000),
      stderr: stderr,
      elapsedMs: Date.now() - start
    });
  }, 60000);

  ytdlp.on('close', (code) => {
    clearTimeout(timer);
    const urls = stdout.trim().split('\n').filter((u) => u.startsWith('http'));
    if (code === 0 && urls.length > 0) {
      cacheStreamUrls(videoId, urls);
    }
    res.json({
      status: code === 0 && urls.length > 0 ? 'success' : 'failed',
      exitCode: code,
      hasCookies: fs.existsSync(COOKIES_PATH),
      elapsedMs: Date.now() - start,
      urlCount: urls.length,
      sampleUrl: urls.length > 0 ? urls[0].substring(0, 80) + '...' : null,
      stderr: stderr
    });
  });

  ytdlp.on('error', (err) => {
    clearTimeout(timer);
    res.status(500).json({ error: err.message, elapsedMs: Date.now() - start });
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Route check
  if (url.pathname !== '/stream' && url.pathname !== '/') {
    ws.close(1002, 'Unsupported path: use /stream?v=<youtubeId>');
    return;
  }

  const videoId = url.searchParams.get('v');

  if (!videoId || !/^[a-zA-Z0-9_-]{1,32}$/.test(videoId)) {
    console.warn('Rejected connection: missing or invalid video ID:', videoId);
    ws.close(1008, 'Missing or invalid video ID');
    return;
  }

  // In an automotive single-driver setting on 512MB RAM, preempt previous stream immediately to prevent OOM
  if (currentActiveSession) {
    console.log(`[Preempt Stream] Terminating previous session for video ${currentActiveSession.videoId} to free memory for ${videoId}...`);
    try { currentActiveSession.cleanup(); } catch (e) {}
    currentActiveSession = null;
  }

  activeStreams++;
  const requestedQuality = url.searchParams.get('q') || url.searchParams.get('quality') || '360p';
  const seekSeconds = Math.max(0, parseFloat(url.searchParams.get('ss') || url.searchParams.get('t') || '0'));
  const profile = QUALITY_PROFILES[requestedQuality] || QUALITY_PROFILES['360p'];
  console.log(`[Stream Started] Video: ${videoId} | Quality: ${requestedQuality} | Seek: ${seekSeconds}s | Active Streams: ${activeStreams}`);

  let ytdlpProcess = null;
  let ffmpegProcess = null;
  let isClosed = false;
  let drainTimer = null;
  let ytdlpTimer = null;
  let chunksEmitted = 0;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    activeStreams = Math.max(0, activeStreams - 1);
    if (currentActiveSession && currentActiveSession.ws === ws) {
      currentActiveSession = null;
    }
    console.log(`[Stream Closed] Video: ${videoId} | Chunks: ${chunksEmitted} | Active Streams: ${activeStreams}`);

    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    if (ytdlpTimer) {
      clearTimeout(ytdlpTimer);
      ytdlpTimer = null;
    }

    // Kill process groups with SIGKILL so no zombie child processes linger
    if (ytdlpProcess && ytdlpProcess.pid) {
      try { process.kill(-ytdlpProcess.pid, 'SIGKILL'); } catch (e) {
        try { ytdlpProcess.kill('SIGKILL'); } catch (e2) {}
      }
      ytdlpProcess = null;
    }
    if (ffmpegProcess && ffmpegProcess.pid) {
      try { process.kill(-ffmpegProcess.pid, 'SIGKILL'); } catch (e) {
        try { ffmpegProcess.kill('SIGKILL'); } catch (e2) {}
      }
      ffmpegProcess = null;
    }

    if (ws.readyState === ws.OPEN) {
      try { ws.close(1000, 'Stream terminated'); } catch (e) {}
    }

    // Explicit garbage collection on stream termination to keep memory strictly under 250MB
    if (activeStreams === 0 && global.gc) {
      try { global.gc(); } catch (e) {}
    }
  };

  currentActiveSession = { videoId, ws, cleanup };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`WebSocket error on ${videoId}:`, err.message);
    cleanup();
  });

  try {
    // Single-thread lightweight real-time MPEG-1 transcode profile strictly tuned for 512MB RAM
    const startFfmpeg = (inputArgs) => {
      // Format input arguments: inject seek offset and HTTP reconnection flags
      let processedInputArgs = [];
      const hasReconnect = inputArgs.includes('-reconnect');
      const isPipe = inputArgs.includes('pipe:0');

      for (let i = 0; i < inputArgs.length; i++) {
        const arg = inputArgs[i];
        if (arg === '-i') {
          if (seekSeconds > 0 && !isPipe) {
            processedInputArgs.push('-ss', seekSeconds.toString());
          }
          if (!hasReconnect && !isPipe) {
            processedInputArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
          }
          processedInputArgs.push('-i');
        } else {
          processedInputArgs.push(arg);
        }
      }
      if (seekSeconds > 0 && !isPipe) {
        console.log(`[FFmpeg Input Seek] Injected -ss ${seekSeconds}s with reconnect flags before input stream(s)...`);
      }

      ffmpegProcess = spawn('ffmpeg', [
        '-threads', '1', // Single thread uses ~40% less memory and runs plenty fast for 25fps MPEG-1
        ...processedInputArgs,
        '-f', 'mpegts',
        '-codec:v', 'mpeg1video',
        '-s', profile.resolution,
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.maxRate,
        '-bufsize', profile.bufSize,
        '-r', profile.fps,
        '-g', profile.gop || '25',
        '-keyint_min', profile.gop || '25',
        '-fps_mode', 'cfr',
        '-qmin', profile.qmin || '3',
        '-qmax', profile.qmax || '12',
        '-bf', '0',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-vf', 'realtime',
        '-max_muxing_queue_size', '128', // Prevent unbounded packet queue buildup in RAM
        '-muxdelay', '0.001',
        '-muxpreload', '0.001',
        '-flush_packets', '1',
        '-codec:a', 'mp2',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '96k',
        '-af', 'arealtime,aresample=async=1000:min_hard_comp=0.100000:first_pts=0',
        '-'
      ], {
        detached: true
      });

      ffmpegProcess.on('exit', () => cleanup());
      ffmpegProcess.on('error', (err) => {
        console.error(`ffmpeg spawn error [${videoId}]:`, err.message);
        cleanup();
      });

      // Capture real-time encoding speed and fps telemetry
      ffmpegProcess.stderr.on('data', (d) => {
        const text = d.toString();
        const speedMatch = text.match(/speed=\s*([\d.]+x)/);
        const fpsMatch = text.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = text.match(/bitrate=\s*([\d.]+\w+)/);
        if (speedMatch || fpsMatch) {
          latestStreamTelemetry = {
            speed: speedMatch ? speedMatch[1] : latestStreamTelemetry.speed,
            fps: fpsMatch ? parseFloat(fpsMatch[1]) : latestStreamTelemetry.fps,
            bitrate: bitrateMatch ? bitrateMatch[1] : latestStreamTelemetry.bitrate,
            lastUpdated: Date.now()
          };
        }
      });

      // Stream binary MPEG-TS chunks over WebSocket with responsive 384KB cellular backpressure guard
      ffmpegProcess.stdout.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          if (ws.bufferedAmount > 384 * 1024) {
            ffmpegProcess.stdout.pause();
            return;
          }
          chunksEmitted++;
          ws.send(chunk, { binary: true });
        }
      });
    };

    // Fast-path: If videoId is a known direct CDN HLS broadcast (e.g. Makkah or Madinah Live)
    if (DIRECT_STREAM_MAP[videoId]) {
      console.log(`[Direct CDN Fast-Path] Routing ${videoId} to official Akamai stream with live sync: ${DIRECT_STREAM_MAP[videoId]}`);
      startFfmpeg([
        '-fflags', '+nobuffer+flush_packets+discardcorrupt',
        '-flags', 'low_delay',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '2',
        '-i', DIRECT_STREAM_MAP[videoId]
      ]);
      return;
    }

    // Fast-path 2: If videoId stream is already cached in memory (Zero-wait start)
    const cachedUrls = getCachedStreamUrls(videoId);
    if (cachedUrls && cachedUrls.length > 0) {
      console.log(`[Cached Stream Fast-Path] Starting instant transcode for ${videoId} from cached URLs (${cachedUrls.length})...`);
      const inputArgs = cachedUrls.length >= 2
        ? ['-i', cachedUrls[0], '-i', cachedUrls[1]]
        : ['-i', cachedUrls[0]];
      startFfmpeg(inputArgs);
      return;
    }

    // Standard YouTube path using yt-dlp with smart client selection
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hasCookies = fs.existsSync(COOKIES_PATH);
    let isFullAuthCookie = false;
    if (hasCookies) {
      try {
        const c = fs.readFileSync(COOKIES_PATH, 'utf8');
        isFullAuthCookie = c.includes('LOGIN_INFO') || c.includes('__Secure-3PSID') || c.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length > 10;
      } catch {}
    }
    const potArgs = isPotServerHealthy
      ? [
          '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
        ]
      : [];
    const ytdlpArgs = [
      '-4',
      '--socket-timeout', '10',
      '--no-playlist',
      '--cache-dir', '/tmp/ytdlp_cache',
      '--no-warnings',
      '--js-runtimes', 'node',
      ...potArgs,
      '-f', '18/b[ext=mp4]/b/bestvideo[height<=720]+bestaudio/best*',
      '-g',
      youtubeUrl
    ];

    if (hasCookies) {
      ytdlpArgs.splice(1, 0, '--cookies', COOKIES_PATH);
    }

    let urlBuffer = '';
    ytdlpProcess = spawn('python3', ['-m', 'yt_dlp', ...ytdlpArgs], {
      detached: true,
      env: {
        ...process.env,
        HOME: '/home/node',
        PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
        PYTHONUNBUFFERED: '1',
        NODE_OPTIONS: '--max-old-space-size=64'
      }
    });

    // 45-second safety watchdog to kill hung extraction before Render 512MB threshold is reached
    ytdlpTimer = setTimeout(() => {
      if (ytdlpProcess && ytdlpProcess.pid) {
        console.warn(`[Extraction Timeout] yt-dlp took >45s for ${videoId}, killing process group...`);
        try { process.kill(-ytdlpProcess.pid, 'SIGKILL'); } catch (e) {
          try { ytdlpProcess.kill('SIGKILL'); } catch (e2) {}
        }
        ytdlpProcess = null;
        if (ws.readyState === ws.OPEN) {
          ws.close(1011, 'Extraction timed out');
        }
      }
    }, 45000);

    ytdlpProcess.stdout.on('data', (d) => {
      urlBuffer += d.toString();
    });

    ytdlpProcess.stderr.on('data', (d) => {
      const msg = d.toString();
      if (msg.includes('ERROR:')) {
        console.error(`yt-dlp [${videoId}] error:`, msg.trim());
      }
    });

    ytdlpProcess.on('close', (code) => {
      if (ytdlpTimer) {
        clearTimeout(ytdlpTimer);
        ytdlpTimer = null;
      }
      if (isClosed) return;
      const rawUrls = urlBuffer.trim().split('\n').filter((u) => u.startsWith('http'));

      if (code === 0 && rawUrls.length > 0) {
        console.log(`[Stream URL Resolved for ${videoId}] Starting direct HTTP transcode & caching URL...`);
        cacheStreamUrls(videoId, rawUrls);
        const inputArgs = rawUrls.length >= 2
          ? ['-i', rawUrls[0], '-i', rawUrls[1]]
          : ['-i', rawUrls[0]];
        startFfmpeg(inputArgs);
      } else {
        console.warn(`[Stream Pipe Fallback for ${videoId}] Falling back to progressive MP4 stdout pipe...`);
        const pipeArgs = [
          '-4',
          '--socket-timeout', '10',
          '--no-playlist',
          '--cache-dir', '/tmp/ytdlp_cache',
          '--no-warnings',
          '--js-runtimes', 'node',
          ...potArgs,
          '-f', '18/b[ext=mp4]/b/best*',
          '-o', '-',
          youtubeUrl
        ];
        if (hasCookies) {
          pipeArgs.splice(1, 0, '--cookies', COOKIES_PATH);
        }
        if (seekSeconds > 0) {
          pipeArgs.splice(1, 0, '--download-sections', `*${seekSeconds}-inf`);
          console.log(`[Pipe Fallback Seek] Added --download-sections *${seekSeconds}-inf`);
        }

        ytdlpProcess = spawn('python3', ['-m', 'yt_dlp', ...pipeArgs], {
          detached: true,
          env: {
            ...process.env,
            HOME: '/home/node',
            PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
            PYTHONUNBUFFERED: '1',
            NODE_OPTIONS: '--max-old-space-size=64'
          }
        });

        startFfmpeg(['-i', 'pipe:0']);
        ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
        ytdlpProcess.stdout.on('error', () => {});
        ffmpegProcess.stdin.on('error', () => {});
        ytdlpProcess.on('exit', () => cleanup());
      }
    });

    ytdlpProcess.on('error', (err) => {
      console.error(`yt-dlp spawn error [${videoId}]:`, err.message);
      cleanup();
    });

    // Buffer drain monitor for vehicular cellular networks
    drainTimer = setInterval(() => {
      if (isClosed) {
        clearInterval(drainTimer);
        return;
      }
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 128 * 1024 && ffmpegProcess && ffmpegProcess.stdout && ffmpegProcess.stdout.isPaused()) {
        ffmpegProcess.stdout.resume();
      }
    }, 100);

  } catch (err) {
    console.error(`Stream initiation failure [${videoId}]:`, err.message);
    cleanup();
  }
});

// Single Page Application (SPA) catch-all fallback for client-side routing
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/health') ||
    req.path.startsWith('/diag') ||
    req.path.startsWith('/cookies') ||
    req.path.startsWith('/stream')
  ) {
    return next();
  }
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tesla Drive Stream Server v5.6.0 (Timeline Seek & Watch History) listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);

  // Active memory watchdog to keep RSS safely under 250MB on Render 512MB Free Tier
  setInterval(() => {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    if (rssMb > 250 && global.gc) {
      console.warn(`[Memory Watchdog] Elevated RSS: ${rssMb}MB (Heap: ${heapMb}MB). Running garbage collection...`);
      try { global.gc(); } catch (e) {}
    }
  }, 30000);
});

// Process signal handlers for clean container shutdown
const gracefulShutdown = () => {
  console.log('Shutting down Tesla Stream Server...');
  if (potServerProcess) {
    try {
      potServerProcess.kill('SIGTERM');
    } catch (e) {}
  }
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
