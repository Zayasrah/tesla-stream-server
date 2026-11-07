const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7860;
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_STREAMS || '8', 10);

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
const POT_SCRIPT = '/opt/bgutil-provider/build/main.js';
if (fs.existsSync(POT_SCRIPT)) {
  try {
    console.log('🚀 Spawning BotGuard Proof-of-Origin Token daemon on 127.0.0.1:4416...');
    potServerProcess = spawn('node', [POT_SCRIPT, '--host', '127.0.0.1', '--port', '4416'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    potServerProcess.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[POT Daemon]', msg);
    });
    potServerProcess.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[POT Daemon Err]', msg);
    });
    potServerProcess.on('exit', (code) => {
      console.warn(`[POT Daemon] Exited with code ${code}`);
    });
  } catch (err) {
    console.error('Failed to spawn POT provider:', err.message);
  }
} else {
  console.log('ℹ️ POT provider script not found at', POT_SCRIPT, '(running in fallback mode)');
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

let activeStreams = 0;

// Health & Probe endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Tesla In-Motion Canvas Video Stream Server',
    version: '5.5.1-embedded-challenge-solver',
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
    fs.writeFileSync(COOKIES_PATH, sanitized, 'utf8');
    const validLines = sanitized.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    console.log(`✅ Cookies sanitized & updated via /cookies API endpoint (${validLines} valid YouTube/Google cookies)!`);
    res.json({ status: 'ok', message: 'Cookies saved successfully', hasCookies: true, validLines });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write cookies: ' + err.message });
  }
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

  res.status(200).json({
    status: 'ok',
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    hasCookies: cookieExists,
    cookieStats,
    streamTelemetry: latestStreamTelemetry,
    hasPotProvider: fs.existsSync(POT_SCRIPT) && !!potServerProcess && !potServerProcess.killed,
    uptime: process.uptime(),
    version: '5.5.1-embedded-challenge-solver'
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
  const potArgs = fs.existsSync(POT_SCRIPT)
    ? [
        '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
      ]
    : [];
  const ytdlpArgs = [
    '-v',
    '-4',
    '--socket-timeout', '10',
    '--no-cache-dir',
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

  const ytdlp = spawn('python3', ['-m', 'yt_dlp', ...ytdlpArgs], {
    env: {
      ...process.env,
      PATH: '/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
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
      error: 'Timeout after 30s',
      stdout: stdout.slice(0, 1000),
      stderr: stderr.slice(-1500),
      elapsedMs: Date.now() - start
    });
  }, 30000);

  ytdlp.on('close', (code) => {
    clearTimeout(timer);
    const urls = stdout.trim().split('\n').filter((u) => u.startsWith('http'));
    res.json({
      status: code === 0 && urls.length > 0 ? 'success' : 'failed',
      exitCode: code,
      hasCookies: fs.existsSync(COOKIES_PATH),
      elapsedMs: Date.now() - start,
      urlCount: urls.length,
      sampleUrl: urls.length > 0 ? urls[0].substring(0, 80) + '...' : null,
      stderr: stderr.slice(-1500)
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

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    console.warn(`Capacity reached: rejecting stream for ${videoId}`);
    ws.close(1013, 'Server busy: maximum stream capacity reached');
    return;
  }

  activeStreams++;
  const requestedQuality = url.searchParams.get('q') || url.searchParams.get('quality') || '360p';
  const profile = QUALITY_PROFILES[requestedQuality] || QUALITY_PROFILES['360p'];
  console.log(`[Stream Started] Video: ${videoId} | Quality: ${requestedQuality} (${profile.resolution} @ ${profile.videoBitrate}) | Active Streams: ${activeStreams}`);

  let ytdlpProcess = null;
  let ffmpegProcess = null;
  let isClosed = false;
  let drainTimer = null;
  let chunksEmitted = 0;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    activeStreams = Math.max(0, activeStreams - 1);
    console.log(`[Stream Closed] Video: ${videoId} | Chunks: ${chunksEmitted} | Active Streams: ${activeStreams}`);

    if (drainTimer) {
      clearInterval(drainTimer);
    }

    if (ytdlpProcess) {
      try { ytdlpProcess.kill('SIGKILL'); } catch (e) {}
      ytdlpProcess = null;
    }
    if (ffmpegProcess) {
      try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
      ffmpegProcess = null;
    }

    if (ws.readyState === ws.OPEN) {
      try { ws.close(1000, 'Stream terminated'); } catch (e) {}
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`WebSocket error on ${videoId}:`, err.message);
    cleanup();
  });

  try {
    // Calibrated zero-drop MPEG-1 transcode profile with strict real-time wall-clock pacing
    const startFfmpeg = (inputArgs) => {
      ffmpegProcess = spawn('ffmpeg', [
        '-threads', '2',
        ...inputArgs,
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
        '-muxdelay', '0.001',
        '-muxpreload', '0.001',
        '-flush_packets', '1',
        '-codec:a', 'mp2',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '96k',
        '-af', 'arealtime,aresample=async=1000:min_hard_comp=0.100000:first_pts=0',
        '-'
      ]);

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
    const potArgs = fs.existsSync(POT_SCRIPT)
      ? [
          '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
        ]
      : [];
    const ytdlpArgs = [
      '-4',
      '--socket-timeout', '10',
      '--no-cache-dir',
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
      env: {
        ...process.env,
        PATH: '/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
        PYTHONUNBUFFERED: '1'
      }
    });

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
      if (isClosed) return;
      const rawUrls = urlBuffer.trim().split('\n').filter((u) => u.startsWith('http'));

      if (code === 0 && rawUrls.length > 0) {
        console.log(`[Stream URL Resolved for ${videoId}] Starting direct HTTP transcode...`);
        const inputArgs = rawUrls.length >= 2
          ? ['-i', rawUrls[0], '-i', rawUrls[1]]
          : ['-i', rawUrls[0]];
        startFfmpeg(inputArgs);
      } else {
        console.warn(`[Stream Pipe Fallback for ${videoId}] Falling back to progressive MP4 stdout pipe...`);
        const pipeArgs = [
          '-4',
          '--socket-timeout', '10',
          '--no-cache-dir',
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

        ytdlpProcess = spawn('python3', ['-m', 'yt_dlp', ...pipeArgs], {
          env: {
            ...process.env,
            PATH: '/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
            PYTHONUNBUFFERED: '1'
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tesla Drive Stream Server v5.5.1 (Embedded Node JS Challenge Solver) listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);
  // Background auto-upgrade of yt-dlp to latest nightly so YouTube JS player updates are always supported
  try {
    const updater = spawn('python3', ['-m', 'pip', 'install', '--upgrade', '--pre', '--break-system-packages', 'yt-dlp[default,curl-cffi]', 'yt-dlp-ejs'], {
      stdio: 'ignore'
    });
    updater.on('error', () => {});
  } catch {}
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
