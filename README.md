# Tesla In-Motion Video Stream Server (Canvas Transcoder)

This microservice enables **Active In-Motion Video Playback** on Tesla center touchscreens by transcoding YouTube streams on-the-fly and pushing binary MPEG-1 packets over a WebSocket to an HTML5 `<canvas>` element (via JSMpeg).

Because the Tesla browser renders the moving video frames onto a `<canvas>` instead of a `<video>` tag, **Tesla's Drive Mode safety daemon never blocks or blanks the screen**, allowing video and audio to play smoothly at any speed.

---

## 🚀 Free 1-Click Deployment (Hugging Face Spaces — 100% Free 24/7)

Hugging Face Spaces provides **free Docker containers with 2 vCPUs and 16GB RAM** that run 24/7 with public HTTPS/WSS URLs at $0 cost.

### Steps (Takes 2 minutes):
1. Create a free account at [huggingface.co](https://huggingface.co) if you don't have one.
2. Click **New Space** -> [huggingface.co/new-space](https://huggingface.co/new-space).
3. Set:
   - **Space name**: `tesla-stream` (or any name you choose)
   - **License**: `mit`
   - **Space SDK**: Select **Docker** -> **Blank**.
   - **Space hardware**: `CPU basic · 2 vCPU · 16 GB RAM · Free`.
4. Click **Create Space**.
5. Upload the 3 files from this `stream-server/` directory:
   - `Dockerfile`
   - `package.json`
   - `server.js`
6. Click **Commit**. Hugging Face will automatically build and start the container in ~60 seconds!
7. Your permanent WebSocket URL will be:
   ```
   wss://<your-username>-tesla-stream.hf.space/stream
   ```
8. In our Tesla Quran web app, click **[إعدادات خادم البث]** (the gear icon on the Canvas player) and paste your URL!

---

## 🐳 Docker Deployment (Any Linux VPS / Railway / Render)

You can run this container on any machine (Ubuntu, Debian, macOS, Railway, Render, or a $4/mo Hetzner VPS):

```bash
# 1. Build Docker image
docker build -t tesla-stream-server .

# 2. Run container on port 7860
docker run -d --name tesla-stream -p 7860:7860 --restart always tesla-stream-server
```

Test that the server is active:
```bash
curl http://localhost:7860/health
# {"status":"ok","activeStreams":0,"uptime":12.5}
```

Connect in Tesla web app:
```
ws://<your-server-ip>:7860/stream
# Or wss://yourdomain.com/stream if reverse-proxied through Nginx/Cloudflare
```

---

## 🔧 Architecture & Parameters
- **Source Extractor:** `yt-dlp` extracts 720p streams.
- **Transcoder:** `ffmpeg` converts to:
  - Video: `mpeg1video`, 1280x720, 1500 kbps, 30 FPS, no B-frames (`-bf 0`).
  - Audio: `mp2`, 44.1 kHz stereo, 128 kbps.
- **Client Decoder:** JSMpeg WebGL canvas renderer (in `src/components/CanvasDrivePlayer.tsx`).
- **Memory & Process Management:** Automatically kills `yt-dlp` and `ffmpeg` processes as soon as the client pauses, disconnects, or changes videos.
