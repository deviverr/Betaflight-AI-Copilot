# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first so the layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- serve -------------------------------------------------------------------
FROM nginx:1.27-alpine AS serve

# openssl is only used by the optional self-signed TLS mode; it is a few
# hundred kilobytes and saves needing a second image.
RUN apk add --no-cache openssl

COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY docker/entrypoint.sh /docker-entrypoint.d/40-copilot-tls.sh
RUN chmod +x /docker-entrypoint.d/40-copilot-tls.sh

ENV COPILOT_TLS=off

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
