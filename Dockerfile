FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json .oxfmtrc.json .oxlintrc.json ./
COPY apps ./apps
COPY content ./content
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
    DATABASE_PATH=/data/gurgur.sqlite \
    RTC_PORT_MIN=40000 \
    RTC_PORT_MAX=40100
RUN mkdir -p /data && chown bun:bun /data
COPY --from=build --chown=bun:bun /app/dist ./
EXPOSE 3000
EXPOSE 40000-40100/udp
VOLUME ["/data"]
CMD ["bun", "apps/server/src/index.js"]
