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

// Multi-tier Quality Profiles for High-Definition and Anti-Stutter In-Motion Playback
const QUALITY_PROFILES = {
  '720p': {
    resolution: '1280x720',
    videoBitrate: '1800k',
    maxRate: '2200k',
    bufSize: '3600k',
    fps: '30'
  },
  '480p': {
    resolution: '854x480',
    videoBitrate: '1100k',
    maxRate: '1400k',
    bufSize: '2200k',
    fps: '25'
  },
  '360p': {
    resolution: '640x360',
    videoBitrate: '600k',
    maxRate: '850k',
    bufSize: '1200k',
    fps: '24'
  }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

let activeStreams = 0;

// Health & Probe endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Tesla In-Motion Canvas Video Stream Server',
    version: '5.0.0-hd-buffer-boost',
    hasCookies: fs.existsSync(COOKIES_PATH),
    hasPotProvider: fs.existsSync(POT_SCRIPT) && !!potServerProcess && !potServerProcess.killed,
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    supportedQualities: Object.keys(QUALITY_PROFILES),
    instructions: 'Connect via WebSocket: wss://<this-host>/stream?v=<youtubeId>&q=720p'
  });
});


// Endpoint to save YouTube cookies directly from the web app UI
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
    return res.status(400).json({ error: 'Invalid cookie content' });
  }
  try {
    fs.writeFileSync(COOKIES_PATH, cookies.trim(), 'utf8');
    console.log('✅ Cookies updated via /cookies API endpoint!');
    res.json({ status: 'ok', message: 'Cookies saved successfully', hasCookies: true });
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
  res.status(200).json({
    status: 'ok',
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    hasCookies: fs.existsSync(COOKIES_PATH),
    hasPotProvider: fs.existsSync(POT_SCRIPT) && !!potServerProcess && !potServerProcess.killed,
    uptime: process.uptime(),
    version: '5.0.0-hd-buffer-boost'
  });
});

// Diagnostic endpoint
app.get('/diag', async (req, res) => {
  const videoId = req.query.v || 'eC4LfEVxvKg';
  const requestedQuality = req.query.q || '720p';
  const profile = QUALITY_PROFILES[requestedQuality] || QUALITY_PROFILES['720p'];
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
  const clientArg = hasCookies
    ? 'youtube:player_client=web'
    : 'youtube:player_client=android,ios,mweb,web';
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
    '--extractor-args', clientArg,
    ...potArgs,
    '-f', '18/b[ext=mp4]/best',
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
  const requestedQuality = url.searchParams.get('q') || url.searchParams.get('quality') || '720p';
  const profile = QUALITY_PROFILES[requestedQuality] || QUALITY_PROFILES['720p'];
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
    // High-definition MPEG-1 transcode profile optimized for Tesla Canvas & cellular buffer cushion
    // Note: '-re' is omitted intentionally so FFmpeg bursts 3-5 seconds of pre-buffer data to the car
    const startFfmpeg = (inputArgs) => {
      ffmpegProcess = spawn('ffmpeg', [
        ...inputArgs,
        '-f', 'mpegts',
        '-codec:v', 'mpeg1video',
        '-s', profile.resolution,
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.maxRate,
        '-bufsize', profile.bufSize,
        '-r', profile.fps,
        '-bf', '0',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-codec:a', 'mp2',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '128k',
        '-'
      ]);

      ffmpegProcess.on('exit', () => cleanup());
      ffmpegProcess.on('error', (err) => {
        console.error(`ffmpeg spawn error [${videoId}]:`, err.message);
        cleanup();
      });

      ffmpegProcess.stderr.on('data', () => {});

      // Stream binary MPEG-TS chunks over WebSocket with backpressure guard
      ffmpegProcess.stdout.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          if (ws.bufferedAmount > 3 * 1024 * 1024) {
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
      console.log(`[Direct CDN Fast-Path] Routing ${videoId} to official Akamai stream: ${DIRECT_STREAM_MAP[videoId]}`);
      startFfmpeg(['-i', DIRECT_STREAM_MAP[videoId]]);
      return;
    }

    // Standard YouTube path using yt-dlp
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hasCookies = fs.existsSync(COOKIES_PATH);
    const clientArg = hasCookies
      ? 'youtube:player_client=web'
      : 'youtube:player_client=android,ios,mweb,web';
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
      '--extractor-args', clientArg,
      ...potArgs,
      '-f', '18/b[ext=mp4]/best[ext=mp4]/b/best',
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
          '--extractor-args', clientArg,
          ...potArgs,
          '-f', '18/best[ext=mp4]/best',
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
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 512 * 1024 && ffmpegProcess && ffmpegProcess.stdout && ffmpegProcess.stdout.isPaused()) {
        ffmpegProcess.stdout.resume();
      }
    }, 100);

  } catch (err) {
    console.error(`Stream initiation failure [${videoId}]:`, err.message);
    cleanup();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tesla Drive Stream Server v4.2.0 (Automated BotGuard POT Provider) listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);
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
