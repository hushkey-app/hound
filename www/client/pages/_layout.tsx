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

  return (
    <main>
      {/* Top-left brand */}
      <div class="fixed top-0 left-0 z-50 p-4 flex items-center gap-2.5">
        <img src="/logo.svg" alt="Hound" class="w-14 h-14" />
        <div class="flex flex-col leading-none gap-1">
          <span class="font-mono font-black text-2xl text-base-content/90 tracking-tight">
            hound
          </span>
          <span class="font-mono text-sm text-base-content/50 tracking-widest">
            by hushkey
          </span>
        </div>
      </div>
      {/* Top-right nav */}
      <nav class="fixed top-0 right-0 z-50 flex items-center gap-2 p-4">
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

      <Component />
    </main>
  );
}
