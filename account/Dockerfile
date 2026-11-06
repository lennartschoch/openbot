FROM oven/bun:1.4.2-alpine
WORKDIR /app
# Dependencies first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# Non-root runtime. /data is the SQLite volume; owning it in the image makes a
# fresh named volume inherit the right ownership.
RUN adduser -D -u 10001 app && mkdir -p /data && chown app:app /data
USER app
ENV OPENBOT_ACCOUNT_HOST=0.0.0.0 \
    OPENBOT_ACCOUNT_PORT=3100 \
    OPENBOT_ACCOUNT_DB=/data/account.sqlite
EXPOSE 3100
CMD ["bun", "run", "src/index.ts"]
