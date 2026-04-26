import type { PageProps } from "@hushkey/howl";
import type { State } from "../../howl.config.ts";
import type { JSX } from "preact/jsx-runtime";

let starsCache: { value: number; at: number } | null = null;
const STARS_TTL = 5 * 60 * 1000;

async function getGithubStars(): Promise<number | null> {
  if (starsCache && Date.now() - starsCache.at < STARS_TTL) {
    return starsCache.value;
  }
  try {
    const res = await fetch("https://api.github.com/repos/mirairoad/hound", {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return starsCache?.value ?? null;
    const data = await res.json();
    starsCache = { value: data.stargazers_count, at: Date.now() };
    return starsCache.value;
  } catch {
    return starsCache?.value ?? null;
  }
}

export default async function Layout(
  { Component, url }: PageProps<unknown, State>,
): Promise<JSX.Element> {
  const stars = await getGithubStars();
  const isHome = url.pathname === "/";
  const isDocs = url.pathname.startsWith("/docs");

  return (
    <main>
      {/* Top brand bar — fades from solid base-100 to transparent so content underneath stays visible while text remains legible */}
      <div class="fixed top-0 left-0 right-0 z-40 pointer-events-none h-20 sm:h-24 bg-linear-to-b from-base-100/95 via-base-100/70 to-transparent backdrop-blur-md mask-[linear-gradient(to_bottom,black_55%,transparent)]" />

      {/* Top-left brand */}
      <div class="fixed top-0 left-0 z-50 p-3 sm:p-4 flex items-center gap-2 sm:gap-3">
        <img src="/logo.svg" alt="Hound" class="w-11 h-11 sm:w-14 sm:h-14" />
        <div class="flex flex-col leading-none gap-1">
          <span class="font-mono font-black text-xl sm:text-2xl text-base-content/90 tracking-tight">
            hound
          </span>
          <span class="font-mono text-[11px] sm:text-sm text-base-content/50 tracking-widest">
            by hushkey
          </span>
        </div>
      </div>

      {/* Top-right nav — desktop only */}
      <nav class="fixed top-0 right-0 z-50 hidden sm:flex items-center gap-2 p-4">
        <a
          href={isHome ? "/docs" : "/"}
          class="btn btn-ghost btn-md rounded-xl text-base text-base-content/70 hover:text-base-content hover:bg-primary/30"
        >
          {isHome ? "Docs" : "Home"}
        </a>
        <a
          href="https://github.com/mirairoad/hound"
          target="_blank"
          class="btn btn-ghost btn-md rounded-xl text-base text-base-content/50 hover:text-base-content hover:bg-primary/30 gap-2"
        >
          GitHub
          {stars !== null && (
            <span class="badge badge-sm badge-ghost font-mono text-xs opacity-70">
              {stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : stars}
            </span>
          )}
        </a>
        <a
          href="https://jsr.io/@hushkey/hound"
          target="_blank"
          class="btn btn-ghost btn-md rounded-xl text-base text-base-content/50 hover:text-base-content hover:bg-primary/30"
        >
          JSR
        </a>
      </nav>

      {/* Page content — pb-[var(--nav-h)] clears the bottom tab bar on mobile */}
      <div class="pb-(--nav-h) sm:pb-0">
        <Component />
      </div>

      {/* Bottom tab bar — mobile only */}
      <nav class="fixed bottom-0 left-0 right-0 z-50 sm:hidden flex items-stretch bg-base-100/98 backdrop-blur-md border-t border-base-300 safe-area-bottom">
        <a
          href="/"
          class={`flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-colors ${
            isHome ? "text-primary" : "text-base-content/50"
          }`}
        >
          <svg
            class="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"
            />
          </svg>
          <span class="font-mono text-[11px] font-bold">Home</span>
        </a>
        <a
          href="/docs"
          class={`flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-colors ${
            isDocs ? "text-primary" : "text-base-content/50"
          }`}
        >
          <svg
            class="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"
            />
          </svg>
          <span class="font-mono text-[11px] font-bold">Docs</span>
        </a>
        <a
          href="https://github.com/mirairoad/hound"
          target="_blank"
          class="flex flex-col items-center justify-center gap-1 flex-1 py-2 text-base-content/50 transition-colors"
        >
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
          <span class="font-mono text-[11px] font-bold">GitHub</span>
        </a>
        <a
          href="https://jsr.io/@hushkey/hound"
          target="_blank"
          class="flex flex-col items-center justify-center gap-1 flex-1 py-2 text-base-content/50 transition-colors"
        >
          <svg
            class="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
            />
          </svg>
          <span class="font-mono text-[11px] font-bold">JSR</span>
        </a>
      </nav>
    </main>
  );
}
