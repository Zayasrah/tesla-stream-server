FROM node:20-bookworm-slim

# Install system dependencies (ffmpeg, python3, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install standalone yt-dlp binary with global execute permissions
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy dependency files and install
COPY package.json ./
RUN npm install --production

# Copy server code
COPY server.js ./
COPY render.yaml ./

# Assign ownership to the built-in 'node' user (UID 1000 in official node image)
RUN chown -R node:node /app
USER node

# Set environment variables
ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

CMD ["node", "server.js"]
