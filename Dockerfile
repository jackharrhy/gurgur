FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY content ./content
COPY experiments ./experiments
COPY packages ./packages
COPY tools ./tools
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun run compile:map && bun run check && bun run build

FROM oven/bun:1.3.14
WORKDIR /app/dist
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/gurgur.sqlite
RUN mkdir -p /data && chown bun:bun /data
COPY --from=build --chown=bun:bun /app/dist ./
USER bun
EXPOSE 3000
VOLUME ["/data"]
CMD ["bun", "apps/server/src/index.js"]
