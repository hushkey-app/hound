import type { PageProps } from "@hushkey/howl";
import type { State } from "../../../howl.config.ts";
import { readManifest } from "../../../server/docs/reader.ts";
import { Head } from "@hushkey/howl/runtime";
import type { JSX } from "preact/jsx-runtime";

export default function DocsIndex(
  _ctx: PageProps<unknown, State>,
): JSX.Element {
  const manifest = readManifest();

  return (
    <>
      <Head>
        <title>Hound — Documentation</title>
        <meta name="description" content="Guides and API reference for Hound, the type-safe job queue for Deno." />
        <meta property="og:title" content="Hound — Documentation" />
        <meta property="og:description" content="Guides and API reference for Hound, the type-safe job queue for Deno." />
        <meta property="og:image" content="https://hound.hushkey.dev/og-image.png" />
        <meta property="og:url" content="https://hound.hushkey.dev/docs" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
      </Head>

      {/* Mobile: px-0 full-bleed. Desktop: centered with padding. */}
      <div class="sm:max-w-3xl sm:mx-auto sm:px-6 py-6 sm:py-12">

        {/* Hero */}
        <div class="mb-8 sm:mb-10 px-0">
          <p class="font-mono text-xs uppercase tracking-widest text-base-content/50 mb-2">
            Documentation
          </p>
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Hound Docs
          </h1>
          <p class="text-base sm:text-lg text-base-content/70 sm:text-base-content/60 leading-relaxed">
            Type-safe, Deno-native job queue. At-least-once delivery, cron
            scheduling, retries, and a management REST API out of the box.
          </p>
          <div class="flex gap-2 mt-4 flex-wrap">
            {["Deno 2.x", "Redis", "Deno KV", "TypeScript"].map((t) => (
              <kbd key={t} class="kbd kbd-sm sm:kbd-md font-mono text-xs sm:text-sm">{t}</kbd>
            ))}
          </div>
        </div>

        {/* Quick start */}
        <div class="rounded-2xl border border-primary/20 bg-primary/5 backdrop-blur px-5 py-4 mb-8 sm:mb-10">
          <p class="font-mono text-xs text-primary/70 uppercase tracking-widest mb-2">
            quick start
          </p>
          <div class="font-mono text-sm overflow-x-auto whitespace-nowrap">
            <span class="text-primary/60 select-none mr-1">$</span>
            <span class="text-base-content/70">deno add </span>
            <span class="text-primary font-semibold">jsr:@hushkey/hound</span>
          </div>
        </div>

        {/* Section grid — 1 col on mobile (full-bleed cards), 2 col on sm+ */}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {manifest.map((item) => (
            <a
              key={item.slug}
              href={`/docs/${item.slug}`}
              class="group rounded-2xl border border-base-300 bg-base-200/60 backdrop-blur hover:border-primary/40 hover:bg-base-200 transition-all overflow-hidden"
            >
              <div class="px-5 py-4 sm:py-5">
                <div class="flex items-start justify-between gap-2">
                  <h2 class="font-semibold text-base sm:text-base group-hover:text-primary transition-colors">
                    {item.title}
                  </h2>
                  <span class="text-base-content/30 group-hover:text-primary transition-colors text-lg shrink-0">
                    →
                  </span>
                </div>
                <p class="text-sm text-base-content/60 mt-1.5 leading-relaxed">
                  {item.description}
                </p>
              </div>
            </a>
          ))}
        </div>

        {/* Footer */}
        <div class="mt-12 pt-6 border-t border-base-300 flex gap-6 text-sm text-base-content/40 font-mono px-0">
          <a href="https://jsr.io/@hushkey/hound" class="hover:text-base-content transition-colors" target="_blank">
            JSR ↗
          </a>
          <a href="https://github.com/mirairoad/hound" class="hover:text-base-content transition-colors" target="_blank">
            GitHub ↗
          </a>
        </div>
      </div>
    </>
  );
}
