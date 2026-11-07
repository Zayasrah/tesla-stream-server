FROM node:22-bookworm-slim

# Install system dependencies (ffmpeg, python3, pip, curl, unzip)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Symlink node to /usr/bin/node
RUN ln -sf /usr/local/bin/node /usr/bin/node

# Install Deno (yt-dlp's natively supported #1 preferred JS challenge solver)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install latest pre-release/nightly yt-dlp, yt-dlp-ejs, curl_cffi, and bgutil-ytdlp-pot-provider
ENV YTDLP_FORCE_EJS_CACHEBUST="2026-11-07-v5.5.3-node22-deno"
RUN pip3 install --no-cache-dir --break-system-packages --upgrade --pre "yt-dlp[default,curl-cffi]" "yt-dlp-ejs" "curl_cffi" "bgutil-ytdlp-pot-provider"

# Copy prebuilt BotGuard Proof-of-Origin Token provider server from official Docker Hub image
COPY --from=brainicism/bgutil-ytdlp-pot-provider:latest /app /opt/bgutil-provider

WORKDIR /app

# Copy dependency files and install
COPY package.json ./
RUN npm install --production

# Copy server code and bundled frontend web app
COPY server.js ./
COPY render.yaml ./
COPY public ./public

# Assign ownership to the built-in 'node' user (UID 1000 in official node image)
RUN chown -R node:node /app /opt/bgutil-provider
USER node

# Set environment variables
ENV PORT=7860
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 7860

CMD ["node", "--max-old-space-size=128", "--expose-gc", "server.js"]
