FROM node:20-bookworm-slim

# Install system dependencies (ffmpeg, python3, pip, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Symlink node to /usr/bin/node so yt-dlp automatically detects Node.js for JS signature deciphering
RUN ln -sf /usr/local/bin/node /usr/bin/node

# Install latest pre-release/nightly yt-dlp (with yt-dlp-ejs & curl_cffi) and bgutil-ytdlp-pot-provider
# Cache-busting build date: 2026-11-07-v5.5
RUN pip3 install --no-cache-dir --break-system-packages --upgrade --pre "yt-dlp[default,curl-cffi]" "curl_cffi" "bgutil-ytdlp-pot-provider"

# Copy prebuilt BotGuard Proof-of-Origin Token provider server from official Docker Hub image
COPY --from=brainicism/bgutil-ytdlp-pot-provider:latest /app /opt/bgutil-provider

WORKDIR /app

# Copy dependency files and install
COPY package.json ./
RUN npm install --production

# Copy server code
COPY server.js ./
COPY render.yaml ./

# Assign ownership to the built-in 'node' user (UID 1000 in official node image)
RUN chown -R node:node /app /opt/bgutil-provider
USER node

# Set environment variables
ENV PORT=7860
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 7860

CMD ["node", "server.js"]
