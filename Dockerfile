# Reachy Mini API - single-stage Node service (no frontend build).
FROM node:20-slim

WORKDIR /app

# Install production deps from a frozen lockfile. Everything the API
# needs is a runtime dependency (no build step), so a plain install
# is enough.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code
COPY server ./server

# HF Spaces convention
ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
