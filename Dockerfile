FROM node:22-bookworm-slim AS web-build

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.15.9 \
    && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=4174 \
    SCRIBE_DATA_DIR=/data/uploads \
    HOME=/data/home \
    PADDLE_PDX_MODEL_SOURCE=BOS \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv antiword \
    && python3 -m venv /opt/venv \
    && mkdir -p /data/home /data/uploads \
    && chown -R node:node /data \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.15.9 \
    && pnpm install --frozen-lockfile --prod

COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY --chown=node:node server.mjs ocr.swift ocr_worker.py ./
COPY --from=web-build --chown=node:node /app/dist ./dist

USER node
EXPOSE 4174
VOLUME ["/data"]

CMD ["npm", "start"]
