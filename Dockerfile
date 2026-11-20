# Watchtower: one container, API + dashboard on port 8080.
# Base image ships Chromium and its system libraries, so the build installs no browser.
# Playwright npm version (package.json) MUST match this tag.
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
# node:sqlite needs Node >= 22.13; fail the build early if the base image is older.
RUN node -e "require('node:sqlite')"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.mjs"]
