# Build only www/ (site + Deno server). Run from repo root: docker build -t remq-www .
FROM denoland/deno:latest

WORKDIR /app

COPY www/ .

RUN deno cache --reload main.ts

CMD ["deno", "task", "serve"]