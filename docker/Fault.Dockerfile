FROM oven/bun:1.4.4 AS build
WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
COPY sdk ./sdk
RUN bun install --frozen-lockfile
COPY src ./src
COPY test/support/live-entry.ts test/support/fault-response.ts ./test/support/
RUN bun build --target=bun test/support/live-entry.ts --outfile=/out/app.js
FROM restic-proton-drive:review
COPY --from=build /out/app.js /app/app.js
