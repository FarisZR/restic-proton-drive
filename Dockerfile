FROM oven/bun:1.4.4 AS build
WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
COPY sdk ./sdk
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build --target=bun src/main.ts --outfile=/out/app.js

FROM oven/bun:1.4.4-slim
COPY --from=build /out/ /app/
COPY --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
RUN mkdir /state && chown bun:bun /state && chmod 700 /state
ENV PROTON_DRIVE_CACHE_DIR=/state PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file HOST=0.0.0.0
USER bun
VOLUME /state
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "/app/app.js", "health"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["serve"]
