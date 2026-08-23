FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=false
ARG NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED=true
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=$NEXT_PUBLIC_AUTH_GOOGLE_ENABLED \
    NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED=$NEXT_PUBLIC_AUTH_EMAIL_OTP_ENABLED
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# Coolify probes Dockerfile applications with curl from inside the container.
RUN apk add --no-cache curl \
    && addgroup --system --gid 10001 delivery \
    && adduser --system --uid 10001 --ingroup delivery delivery
COPY --from=build --chown=delivery:delivery /app/.next/standalone ./
USER delivery
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:3000/health"]
CMD ["node", "server.js"]
