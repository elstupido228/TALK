# Сервис портала: Node.js + SQLite (файл в томе /data).
# poppler-utils (pdftoppm) понадобится шлюзу /api/extract на шаге 4 — рендер страниц PDF без тяжёлых браузеров.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=256

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app ./app
COPY seed ./seed
COPY scripts ./scripts
COPY bench/pdf ./bench/pdf

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "app/server.js"]
