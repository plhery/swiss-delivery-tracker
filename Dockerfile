FROM node:22-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.13-slim AS runtime
ARG TRACKER_COMMIT=62ae24f5677b3ff2d1af5d08574dc544c365a14d
COPY requirements.txt /tmp/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip install --no-cache-dir "swiss-delivery-tracker @ git+https://github.com/blue-plhery-assistant/swiss-delivery-tracker.git@${TRACKER_COMMIT}" \
    && apt-get purge -y git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=web-build /app/dist ./dist
COPY server ./server
COPY contracts ./contracts
RUN useradd --system --uid 10001 --create-home delivery \
    && chown -R delivery:delivery /app
USER delivery
ENV PORT=3000 \
    STATIC_DIR=/app/dist \
    PYTHONUNBUFFERED=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3000/health >/dev/null
CMD ["python", "-m", "server.app"]
