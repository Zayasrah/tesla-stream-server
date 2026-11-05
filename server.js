const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 7860; // 7860 is default for Hugging Face Spaces & standard cloud

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
    instructions: 'Connect via WebSocket: wss://<this-host>/stream?v=<youtubeId>'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', activeStreams, uptime: process.uptime() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const videoId = url.searchParams.get('v');

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    console.warn('Rejected connection: missing or invalid video ID:', videoId);
    ws.close(1008, 'Missing or invalid 11-char YouTube Video ID');
    return;
  }

  activeStreams++;
  console.log(`[Stream Started] Video: ${videoId} | Active Streams: ${activeStreams}`);

  let ytdlpProcess = null;
  let ffmpegProcess = null;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    activeStreams = Math.max(0, activeStreams - 1);
    console.log(`[Stream Closed] Video: ${videoId} | Active Streams: ${activeStreams}`);

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
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`WebSocket error on ${videoId}:`, err.message);
    cleanup();
  });

  try {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // 1. Spawn yt-dlp to extract the raw video/audio stream
    ytdlpProcess = spawn('yt-dlp', [
      '-f', 'best[height<=720]/best',
      '-o', '-',
      youtubeUrl
    ]);

    // 2. Spawn ffmpeg to transcode into MPEG-1 Video + MP2 Audio for JSMpeg
    ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',
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

    // Pipe yt-dlp output directly to ffmpeg stdin with EPIPE suppression
    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
    ytdlpProcess.stdout.on('error', () => {});
    ffmpegProcess.stdin.on('error', () => {});

    ytdlpProcess.on('exit', () => cleanup());
    ffmpegProcess.on('exit', () => cleanup());

    ytdlpProcess.stderr.on('data', (d) => {
      // Diagnostic logging (first 100 bytes)
      const msg = d.toString();
      if (msg.includes('ERROR:')) {
        console.error(`yt-dlp [${videoId}] error:`, msg.trim());
      }
    });

    ffmpegProcess.stderr.on('data', (d) => {
      // ffmpeg diagnostic logging
    });

    ytdlpProcess.on('error', (err) => {
      console.error(`yt-dlp spawn error [${videoId}]:`, err.message);
      cleanup();
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`ffmpeg spawn error [${videoId}]:`, err.message);
      cleanup();
    });

    // Stream binary MPEG-TS chunks over WebSocket to Tesla browser
    ffmpegProcess.stdout.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk, { binary: true });
      }
    });

  } catch (err) {
    console.error(`Stream initiation failure [${videoId}]:`, err.message);
    cleanup();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tesla Drive Stream Server listening on http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket ready at ws://0.0.0.0:${PORT}/stream?v=<youtubeId>`);
});
