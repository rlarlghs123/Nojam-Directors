# For a home server or NAS (Synology, QNAP, Unraid, a Raspberry Pi 4/5 …).
FROM node:22-bookworm-slim

# ffmpeg: video/audio thumbnails. poppler-utils: PDF first-page thumbnails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips downloading the bundled ffmpeg; the system one above is used instead.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ARCHIVE_DIR=/library \
    DATA_DIR=/data
EXPOSE 3000
VOLUME ["/library", "/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
