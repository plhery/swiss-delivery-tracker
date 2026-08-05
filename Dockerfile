FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS web-build
WORKDIR /app
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_AUTH_GOOGLE_ENABLED=false
ARG VITE_AUTH_EMAIL_OTP_ENABLED=true
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_AUTH_GOOGLE_ENABLED=$VITE_AUTH_GOOGLE_ENABLED \
    VITE_AUTH_EMAIL_OTP_ENABLED=$VITE_AUTH_EMAIL_OTP_ENABLED
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.13-slim@sha256:bf503bb2243c5aad0aa951544dd60d165f992646441d35dea90893703fc26251 AS runtime
COPY requirements.lock /tmp/requirements.lock
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
    && curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      https://codeload.github.com/blue-plhery-assistant/swiss-delivery-tracker/tar.gz/62ae24f5677b3ff2d1af5d08574dc544c365a14d \
      --output /tmp/swiss-delivery-tracker.tar.gz \
    && echo "4f11cfb442e9e6c50a5cc12a7413c1a84e6b17bfcc5bc1a60a589c633fb9168a  /tmp/swiss-delivery-tracker.tar.gz" \
      | sha256sum --check --strict - \
    && pip install --no-cache-dir --no-deps --no-build-isolation \
      /tmp/swiss-delivery-tracker.tar.gz \
    && rm -f /tmp/swiss-delivery-tracker.tar.gz \
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
