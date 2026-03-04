# ---------- Stage 1: bundle the app for production once (force amd64 to avoid wasm/qemu woes)
FROM denoland/deno:latest

ARG GIT_REVISION
ENV DENO_DEPLOYMENT_ID=${GIT_REVISION}

WORKDIR /app

COPY www/ .

RUN deno cache --reload main.ts

CMD ["deno", "task", "serve"]