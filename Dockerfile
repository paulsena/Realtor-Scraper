# ── Builder ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Chrome dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    dumb-init \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Install Google Chrome stable (supports AMD64 + ARM64)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      wget -q -O /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" && \
      apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb && \
      rm /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*; \
    elif [ "$ARCH" = "arm64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium && \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable && \
      rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# Copy built JS and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data

# Create non-root user
RUN groupadd -r scraper && useradd -r -g scraper -d /app scraper && \
    chown -R scraper:scraper /app

USER scraper

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "node", "dist/index.js"]
