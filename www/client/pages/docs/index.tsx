import type { PageProps } from "@hushkey/howl";
import type { State } from "../../../howl.config.ts";
import { readManifest } from "../../../server/docs/reader.ts";
import { Head } from "@hushkey/howl/runtime";
import type { JSX } from "preact/jsx-runtime";

export default async function DocsIndex(
  _ctx: PageProps<unknown, State>,
): Promise<JSX.Element> {
  const manifest = await readManifest();

  return (
    <>
      <Head>
        <title>Hound — Documentation</title>
      </Head>

      <div class="max-w-3xl mx-auto px-6 py-12">
        {/* Hero */}
        <div class="mb-10">
          <p class="font-mono text-xs uppercase tracking-widest text-base-content/30 mb-3">
            Documentation
          </p>
          <h1 class="text-4xl font-bold tracking-tight mb-3">
            Hound Docs
          </h1>
          <p class="text-lg text-base-content/60 max-w-2xl">
            Type-safe, Deno-native job queue. At-least-once delivery, cron
            scheduling, retries, and a management REST API out of the box.
          </p>
          <div class="flex gap-2 mt-4 flex-wrap">
            {["Deno 2.x", "Redis", "Deno KV", "TypeScript"].map((t) => (
              <kbd key={t} class="kbd kbd-sm font-mono">{t}</kbd>
            ))}
          </div>
        </div>

        {/* Quick start */}
        <div class="rounded-xl border border-primary/20 bg-primary/5 backdrop-blur px-5 py-4 mb-10 flex items-center gap-4">
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="w-2 h-2 rounded-full bg-error/60" />
            <span class="w-2 h-2 rounded-full bg-warning/60" />
            <span class="w-2 h-2 rounded-full bg-success/60" />
          </div>
          <div>
            <p class="font-mono text-xs text-primary/60 uppercase tracking-widest mb-1">
              quick start
            </p>
            <div class="font-mono text-sm">
              <span class="text-primary/50 select-none mr-1">$</span>
              <span class="text-base-content/70">deno add </span>
              <span class="text-primary">jsr:@hushkey/hound</span>
            </div>
          </div>
        </div>

        {/* Section grid */}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {manifest.map((item) => (
            <a
              key={item.slug}
              href={`/docs/${item.slug}`}
              class="group rounded-xl border border-base-300 bg-base-200/60 backdrop-blur hover:border-primary/40 hover:bg-base-200 transition-all overflow-hidden"
            >
              <div class="px-5 py-4">
                <div class="flex items-start justify-between gap-2">
                  <h2 class="font-semibold text-base group-hover:text-primary transition-colors">
                    {item.title}
                  </h2>
                  <span class="text-base-content/30 group-hover:text-primary transition-colors text-lg shrink-0">
                    →
                  </span>
                </div>
                <p class="text-sm text-base-content/50 mt-1">
                  {item.description}
                </p>
              </div>
            </a>
          ))}
        </div>

        {/* Footer */}
        <div class="mt-16 pt-8 border-t border-base-300 flex gap-6 text-sm text-base-content/30 font-mono">
          <a
            href="https://jsr.io/@hushkey/hound"
            class="hover:text-base-content transition-colors"
            target="_blank"
          >
            JSR ↗
          </a>
          <a
            href="https://github.com/mirairoad/hound"
            class="hover:text-base-content transition-colors"
            target="_blank"
          >
            GitHub ↗
          </a>
        </div>
      </div>
    </>
  );
}
