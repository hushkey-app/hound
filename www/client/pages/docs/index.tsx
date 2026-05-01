import type { PageProps } from "@hushkey/howl";
import type { State } from "../../../howl.config.ts";
import { readManifest } from "../../../server/docs/reader.ts";
import { Head } from "@hushkey/howl/runtime";
import type { JSX } from "preact/jsx-runtime";

export default function DocsIndex(ctx: PageProps<unknown, State>): JSX.Element {
  const manifest = readManifest();
  const title = ctx.state.client.title;

  return (
    <>
      <Head>
        <title>{title} — Documentation</title>
        <meta
          name="description"
          content={`Guides and reference for ${title}.`}
        />
      </Head>

      <div class="sm:max-w-3xl sm:mx-auto sm:px-6">
        <div class="mb-6 px-0">
          <p class="font-mono text-xs uppercase tracking-widest text-base-content/50 mb-2">
            Documentation
          </p>
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            {title} Docs
          </h1>
          <p class="text-base sm:text-lg text-base-content/70 sm:text-base-content/60 leading-relaxed">
            Guides and reference for Hound job queue installation, defining
            jobs, cron, retries, storage backends, and the management API.
          </p>
        </div>

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
      </div>
    </>
  );
}
