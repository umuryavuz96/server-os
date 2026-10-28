# Server OS for Linux hosts (the native service via server-os-setup is the recommended install).
# docker run -d --name server-os -p 3094:3094 -v server-os:/data -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/umuryavuz96/server-os
# The Docker socket lets Server OS start/stop/install containers on the host; leave it out for a read-only panel.
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli docker-compose curl procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/server ./server
COPY --from=build /src/web/dist ./web/dist
COPY --from=build /src/spec ./spec
COPY --from=build /src/recipes ./recipes
COPY --from=build /src/agent ./agent
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./
ENV SERVER_OS_HOME=/data HOST=0.0.0.0 PORT=3094 NODE_ENV=production
VOLUME /data
EXPOSE 3094
HEALTHCHECK CMD curl -fsS http://127.0.0.1:3094/api/v1/info || exit 1
CMD ["sh", "-c", "bun run server/cli.ts init >/dev/null && exec bun run server/index.ts"]
