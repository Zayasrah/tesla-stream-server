const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 7860;
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_STREAMS || '8', 10);

const app = express();
app.use(cors());
app.use(express.json());

let activeStreams = 0;

// Health & Probe endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Tesla In-Motion Canvas Video Stream Server',
    version: '2.0.0-hardened',
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    instructions: 'Connect via WebSocket: wss://<this-host>/stream?v=<youtubeId>'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    uptime: process.uptime(),
    version: '2.0.0-hardened'
  });
});

// Live diagnostic endpoint for automated testing & verification
app.get('/diag', (req, res) => {
  const videoId = req.query.v || 'gCNeDWCI0vo';
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid 11-char video ID' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const start = Date.now();

  const ytdlp = spawn('yt-dlp', [
    '--extractor-args', 'youtube:player_client=android,ios',
    '--no-warnings',
    '-f', '18/b[ext=mp4]/best[ext=mp4]/b/best',
    '-g',
    youtubeUrl
  ]);

  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', (d) => { stdout += d.toString(); });
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    try { ytdlp.kill('SIGKILL'); } catch (e) {}
    res.status(504).json({
      error: 'Timeout after 20s',
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(-1000),
      elapsedMs: Date.now() - start
    });
  }, 20000);

  ytdlp.on('close', (code) => {
    clearTimeout(timer);
    const urls = stdout.trim().split('\n').filter((u) => u.startsWith('http'));
    res.json({
      status: code === 0 && urls.length > 0 ? 'success' : 'failed',
      videoId,
      exitCode: code,
      elapsedMs: Date.now() - start,
      urlCount: urls.length,
      sampleUrl: urls.length > 0 ? urls[0].substring(0, 80) + '...' : null,
      stderr: stderr.slice(-1000)
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

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    console.warn('Rejected connection: missing or invalid video ID:', videoId);
    ws.close(1008, 'Missing or invalid 11-char YouTube Video ID');
    return;
  }

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    console.warn(`Capacity reached: rejecting stream for ${videoId}`);
    ws.close(1013, 'Server busy: maximum stream capacity reached');
    return;
  }

  activeStreams++;
  console.log(`[Stream Started] Video: ${videoId} | Active Streams: ${activeStreams}`);

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
      try {
        ytdlpProcess.kill('SIGKILL');
      } catch (e) {
        // Ignored
      }
      ytdlpProcess = null;
    }
    if (ffmpegProcess) {
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch (e) {
        // Ignored
      }
      ffmpegProcess = null;
    }

    if (ws.readyState === ws.OPEN) {
      try {
        ws.close(1000, 'Stream terminated');
      } catch (e) {
        // Ignored
      }
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`WebSocket error on ${videoId}:`, err.message);
    cleanup();
  });

  try {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Optimized FFmpeg transcode profile for low-spec cloud containers (640x360 @ 24fps)
    const startFfmpeg = (inputArgs) => {
      ffmpegProcess = spawn('ffmpeg', [
        '-re',
        ...inputArgs,
        '-f', 'mpegts',
        '-codec:v', 'mpeg1video',
        '-s', '640x360',
        '-b:v', '600k',
        '-maxrate', '850k',
        '-bufsize', '1200k',
        '-r', '24',
        '-bf', '0',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-codec:a', 'mp2',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '96k',
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
          if (ws.bufferedAmount > 2 * 1024 * 1024) {
            ffmpegProcess.stdout.pause();
            return;
          }
          chunksEmitted++;
          ws.send(chunk, { binary: true });
        }
      });
    };

    // Stage 1: Resolve direct stream URLs with yt-dlp using mobile client emulation
    let urlBuffer = '';
    ytdlpProcess = spawn('yt-dlp', [
      '--extractor-args', 'youtube:player_client=android,ios',
      '--no-warnings',
      '-f', '18/b[ext=mp4]/best[ext=mp4]/b/best',
      '-g',
      youtubeUrl
    ]);

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
        console.log(`[Stream URL Resolved for ${videoId}] Stream count: ${rawUrls.length}. Starting direct HTTP transcode...`);
        const inputArgs = rawUrls.length >= 2
          ? ['-i', rawUrls[0], '-i', rawUrls[1]]
          : ['-i', rawUrls[0]];
        startFfmpeg(inputArgs);
      } else {
        console.warn(`[Stream Pipe Fallback for ${videoId}] Falling back to progressive MP4 stdout pipe...`);
        // Use format 18 (pre-merged 360p progressive MP4) so stdout pipe NEVER requires seeking
        ytdlpProcess = spawn('yt-dlp', [
          '--extractor-args', 'youtube:player_client=android,ios',
          '--no-warnings',
          '-f', '18/best[ext=mp4]/best',
          '-o', '-',
          youtubeUrl
        ]);

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
  console.log(`🚀 Tesla Drive Stream Server v2.0.0 listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);
});
