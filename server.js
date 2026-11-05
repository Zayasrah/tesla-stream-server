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
    activeStreams,
    maxStreams: MAX_CONCURRENT_STREAMS,
    instructions: 'Connect via WebSocket: wss://<this-host>/stream?v=<youtubeId>'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', activeStreams, maxStreams: MAX_CONCURRENT_STREAMS, uptime: process.uptime() });
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

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    activeStreams = Math.max(0, activeStreams - 1);
    console.log(`[Stream Closed] Video: ${videoId} | Active Streams: ${activeStreams}`);

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

    const startFfmpeg = (inputArgs) => {
      ffmpegProcess = spawn('ffmpeg', [
        ...inputArgs,
        '-f', 'mpegts',
        '-codec:v', 'mpeg1video',
        '-s', '1280x720',
        '-b:v', '1500k',
        '-r', '30',
        '-bf', '0',
        '-codec:a', 'mp2',
        '-ar', '44100',
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
          if (ws.bufferedAmount > 2 * 1024 * 1024) {
            ffmpegProcess.stdout.pause();
            return;
          }
          ws.send(chunk, { binary: true });
        }
      });
    };

    // First attempt: extract direct streaming URL with yt-dlp -g (Fastest, seekable HTTP)
    let urlBuffer = '';
    ytdlpProcess = spawn('yt-dlp', [
      '-f', 'b[ext=mp4]/best[ext=mp4]/b/18/22/best',
      '-g',
      youtubeUrl
    ]);

    ytdlpProcess.stdout.on('data', (d) => {
      urlBuffer += d.toString();
    });

    ytdlpProcess.on('close', (code) => {
      if (isClosed) return;
      const rawUrls = urlBuffer.trim().split('\n').filter(u => u.startsWith('http'));
      if (code === 0 && rawUrls.length > 0) {
        console.log(`[Stream URL Resolved for ${videoId}] Starting direct ffmpeg HTTP transcode...`);
        const inputArgs = rawUrls.length >= 2
          ? ['-re', '-i', rawUrls[0], '-i', rawUrls[1]]
          : ['-re', '-i', rawUrls[0]];
        startFfmpeg(inputArgs);
      } else {
        console.warn(`[Stream Pipe Fallback for ${videoId}] Falling back to piped stdin...`);
        ytdlpProcess = spawn('yt-dlp', [
          '-f', 'b[ext=mp4]/best[ext=mp4]/b/18/22',
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

    // Buffer drain monitor for cellular networks
    drainTimer = setInterval(() => {
      if (isClosed) {
        clearInterval(drainTimer);
        return;
      }
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 512 * 1024 && ffmpegProcess && ffmpegProcess.stdout.isPaused()) {
        ffmpegProcess.stdout.resume();
      }
    }, 100);

  } catch (err) {
    console.error(`Stream initiation failure [${videoId}]:`, err.message);
    cleanup();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tesla Drive Stream Server listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);
});
