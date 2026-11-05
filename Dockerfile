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

# Set up non-root user for Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app

# Copy dependency files with user ownership and install
COPY --chown=user package.json ./
RUN npm install --production

# Copy server code with user ownership
COPY --chown=user server.js ./

# Set environment variables (7860 is default port for Hugging Face Spaces)
ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

CMD ["node", "server.js"]
