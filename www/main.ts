/**
 * Serves the www site (pages + assets) over HTTP.
 * Version badge and doc version are injected from www/deno.json (synced from core when run in monorepo).
 * Run from repo root: deno run -A www/main.ts
 * Or from www: deno run -A main.ts
 */

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

// When core exists (monorepo), overwrite www/deno.json version so shipped www has it
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
  // No core (shipped www only) — use www/deno.json as-is
}

const REMQ_VERSION = getRemqVersion();

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function getMime(pathname: string): string {
  if (!pathname || pathname === "/" || pathname.endsWith(".html")) {
    return "text/html";
  }
  const ext = pathname.includes(".") ? pathname.replace(/.*\./, ".") : "";
  return MIME[ext] ?? "application/octet-stream";
}

/** Resolve request path to a file under BASE (www/). */
function resolve(pathname: string): URL | null {
  const normalized = pathname.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (normalized.includes("..")) return null;

  // Routes: pages and asset aliases
  if (normalized === "" || normalized === "index.html") {
    return new URL("pages/index.html", BASE);
  }
  if (normalized === "docs.html") {
    return new URL("pages/docs.html", BASE);
  }
  if (normalized === "style.css") {
    return new URL("assets/style/style.css", BASE);
  }
  if (normalized === "script.js") {
    return new URL("assets/js/script.js", BASE);
  }
  if (normalized === "favicon.ico" || normalized === "public/favicon.ico") {
    return new URL("assets/img/favicon.ico", BASE);
  }
  if (normalized === "logo.png" || normalized === "public/logo.png") {
    return new URL("assets/img/logo.png", BASE);
  }
  // Direct assets
  if (normalized.startsWith("assets/")) {
    return new URL(normalized, BASE);
  }

  return null;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const fileUrl = resolve(pathname);

  if (!fileUrl) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const mime = getMime(pathname);
    let body: Uint8Array | string = await Deno.readFile(fileUrl);

    if (mime === "text/html") {
      const html = new TextDecoder().decode(body);
      body = html.replaceAll("{{REMQ_VERSION}}", REMQ_VERSION);
    }

    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=3600"
          : "no-cache",
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response("Not Found", { status: 404 });
    }
    console.error(e);
    return new Response("Internal Server Error", { status: 500 });
  }
}

const port = Number(Deno.env.get("PORT")) || 8080;
console.log(`Serving www at http://localhost:${port}`);
Deno.serve({ port }, handle);
