FROM node:24-bookworm-slim AS build
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends python3 python3-venv antiword ffmpeg && rm -rf /var/lib/apt/lists/*
ARG PIP_INDEX_URL=https://pypi.org/simple
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 PYTHONDONTWRITEBYTECODE=1
COPY backend/parsers ./parsers
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir --require-hashes -r parsers/requirements.txt
COPY --from=build /build/backend/package.json /build/backend/package-lock.json ./
COPY --from=build /build/backend/node_modules ./node_modules
COPY --from=build /build/backend/dist ./dist
COPY backend/resources ./resources
COPY backend/migrations ./migrations
RUN useradd --uid 10001 --user-group --create-home app && install -d -m 0700 -o app -g app /app/data/sessions /app/data/visit-audio
USER app
EXPOSE 8000
CMD ["node", "dist/main.js"]
