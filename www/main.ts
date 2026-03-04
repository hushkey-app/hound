/**
 * Serves the www site (pages + assets) over HTTP.
 * Version badge and doc version are injected from www/deno.json (synced from core when run in monorepo).
 * Run from repo root: deno run -A www/main.ts
 * Or from www: deno run -A main.ts
 * In Docker/deploy: files are resolved from Deno.cwd() (WORKDIR /app).
 */

const BASE = new URL(".", import.meta.url);
const CWD = Deno.cwd();
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

/** Resolve request path to a file path (cwd-based so Docker/deploy finds files). */
function resolvePath(pathname: string): string | null {
  const normalized = pathname.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (normalized.includes("..")) return null;

  const base = CWD + (CWD.endsWith("/") ? "" : "/");
  if (normalized === "" || normalized === "index.html") return base + "pages/index.html";
  if (normalized === "docs.html") return base + "pages/docs.html";
  if (normalized === "style.css") return base + "assets/style/style.css";
  if (normalized === "script.js") return base + "assets/js/script.js";
  if (normalized === "favicon.ico" || normalized === "public/favicon.ico") return base + "assets/img/favicon.ico";
  if (normalized === "logo.png" || normalized === "public/logo.png") return base + "assets/img/logo.png";
  if (normalized.startsWith("assets/")) return base + normalized;
  return null;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const filePath = resolvePath(pathname);

  if (!filePath) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const mime = getMime(pathname);
    let body: Uint8Array | string = await Deno.readFile(filePath);

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
