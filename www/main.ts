/**
 * Serves the www site with Hono.
 * Version from www/deno.json (synced from core when run in monorepo).
 * Run: deno run -A main.ts  or  deno task serve
 * Docker: COPY www/ . → files at /app, BASE is file:///app/
 */

import { type Context, Hono } from "hono";
import index from "./pages/index.html" with { type: "text" };
import docs from "./pages/docs.html" with { type: "text" };

const BASE = new URL(".", import.meta.url);
const WWW_DENO_JSON = new URL("deno.json", BASE);
const CORE_DENO_JSON = new URL("../core/deno.json", BASE);

function getRemqVersion(): string {
  try {
    const json = JSON.parse(Deno.readTextFileSync(WWW_DENO_JSON));
    const v = json?.version;
    return typeof v === "string" ? "v" + v : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

try {
  const coreJson = JSON.parse(Deno.readTextFileSync(CORE_DENO_JSON));
  const coreVersion = coreJson?.version;
  if (typeof coreVersion === "string") {
    const wwwJson = JSON.parse(Deno.readTextFileSync(WWW_DENO_JSON));
    wwwJson.version = coreVersion;
    Deno.writeTextFileSync(
      WWW_DENO_JSON,
      JSON.stringify(wwwJson, null, 2) + "\n",
    );
  }
} catch {
  /* no core — use www/deno.json as-is */
}

const REMQ_VERSION = getRemqVersion();

async function readFile(path: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(path, BASE));
}

/** Base path when behind a proxy (e.g. Cloudflare path): set BASE_PATH=/remq so app serves at /remq and /remq/ */
const BASE_PATH = (Deno.env.get("BASE_PATH") ?? "").replace(/\/$/, "") || "";

function injectVersion(html: string): string {
  let out = html
    .replaceAll("{{REMQ_VERSION}}", REMQ_VERSION)
    .replaceAll("{{BASE_PATH}}", BASE_PATH);
  // Collapse double slashes in paths (avoid /remq//#features) but keep https://
  out = out.replace(/([^:])\/\/+/g, "$1/");
  return out;
}

const site = new Hono();

site.get("", (c: Context) => c.html(injectVersion(index)));
site.get("/", (c: Context) => c.html(injectVersion(index)));
site.get("/docs", (c: Context) => c.html(injectVersion(docs)));

site.get("/style.css", async (_c: Context) => {
  const body = await readFile("assets/style/style.css");
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": "text/css",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

site.get("/script.js", async (_c: Context) => {
  const body = await readFile("assets/js/script.js");
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

site.get("/favicon.ico", async (_c: Context) => {
  const body = await readFile("assets/img/favicon.ico");
  return new Response(body as BodyInit, {
    headers: { "Content-Type": "image/x-icon" },
  });
});

site.get("/public/favicon.ico", async (_c: Context) => {
  const body = await readFile("assets/img/favicon.ico");
  return new Response(body as BodyInit, {
    headers: { "Content-Type": "image/x-icon" },
  });
});

site.get("/logo.png", async (_c: Context) => {
  const body = await readFile("assets/img/logo.png");
  return new Response(body as BodyInit, {
    headers: { "Content-Type": "image/png" },
  });
});

site.get("/public/logo.png", async (_c: Context) => {
  const body = await readFile("assets/img/logo.png");
  return new Response(body as BodyInit, {
    headers: { "Content-Type": "image/png" },
  });
});

site.get("/assets/*", async (c: Context) => {
  const path = c.req.path.replace(/^\/assets/, "assets");
  try {
    const body = await readFile(path);
    const ext = path.replace(/.*\./, "");
    const mimes: Record<string, string> = {
      css: "text/css",
      js: "application/javascript",
      ico: "image/x-icon",
      png: "image/png",
      svg: "image/svg+xml",
    };
    const type = mimes[ext] ?? "application/octet-stream";
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return c.notFound();
  }
});

site.all("*", (c: Context) => c.notFound());

const app = BASE_PATH ? (() => {
  const a = new Hono();
  a.route(BASE_PATH, site);
  return a;
})() : site;

const port = Number(Deno.env.get("PORT")) || 8080;
console.log(`Serving www at http://localhost:${port}${BASE_PATH ? BASE_PATH : ""}`);

Deno.serve({ port }, app.fetch);
