FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY src ./src
COPY arena ./arena
COPY package.json ./
ENTRYPOINT ["bun", "/bot/src/main.ts"]
