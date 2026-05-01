import { Head } from "@hushkey/howl/runtime";
import type { Context } from "@hushkey/howl";
import type { State } from "../../howl.config.ts";
import type { JSX } from "preact/jsx-runtime";

const PLANETS = [
  { r: 95, size: 7, color: "#9ca3af", duration: "4s", rings: false },
  { r: 122, size: 9, color: "#fbbf24", duration: "7s", rings: false },
  { r: 150, size: 9, color: "#60a5fa", duration: "11s", rings: false },
  { r: 180, size: 8, color: "#f87171", duration: "18s", rings: false },
  { r: 232, size: 19, color: "#d97706", duration: "40s", rings: false },
  { r: 282, size: 14, color: "#fcd34d", duration: "80s", rings: true },
  { r: 326, size: 11, color: "#67e8f9", duration: "140s", rings: false },
  { r: 368, size: 11, color: "#3b82f6", duration: "200s", rings: false },
  { r: 406, size: 5, color: "#c4b5fd", duration: "270s", rings: false },
];

const BENCHMARKS = [
  {
    label: "baseline",
    jobs: "10,000 jobs · c=1",
    throughput: "4,476 ops/s",
    duration: "2.23s",
    latency: [["avg", "1213ms"]],
    tier: "dim",
  },
  {
    label: "10 workers",
    jobs: "10,000 jobs · c=10",
    throughput: "14,434 ops/s",
    duration: "0.69s",
    latency: [["avg", "475ms"]],
    tier: "mid",
  },
  {
    label: "ceiling",
    jobs: "100,000 · c=10k",
    throughput: "34,371 ops/s",
    duration: "2.91s",
    latency: [["avg", "2473ms"]],
    tier: "top",
  },
];

export default function Index(ctx: Context<State>): JSX.Element {
  const title = ctx.state.client.title;
  const version = ctx.state.client.version;

  return (
    <>
      <Head>
        <title>{title} | Job queue for Deno</title>
        <meta
          name="description"
          content="Type-safe job queue for Deno. At-least-once delivery, cron scheduling, automatic retries, and a management REST API."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://hound.hushkey.dev" />
        <meta property="og:title" content={`${title} — Job queue for Deno`} />
        <meta
          property="og:description"
          content="Type-safe job queue for Deno. At-least-once delivery, cron scheduling, automatic retries, and a management REST API."
        />
        <meta
          property="og:image"
          content="https://hound.hushkey.dev/og-image.png"
        />
        <meta
          property="og:image:secure_url"
          content="https://hound.hushkey.dev/og-image.png"
        />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Hound — Type-safe job queue for Deno"
        />
        <meta property="og:site_name" content="Hound" />
        <meta property="og:locale" content="en_US" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`${title} — Job queue for Deno`} />
        <meta
          name="twitter:description"
          content="Type-safe job queue for Deno. At-least-once delivery, cron scheduling, automatic retries, and a management REST API."
        />
        <meta
          name="twitter:image"
          content="https://hound.hushkey.dev/og-image.png"
        />
      </Head>

      <div class="relative bg-base-100 bg-dot-grid bg-size-[28px_28px] overflow-hidden">
        <div class="pointer-events-none absolute inset-0 overflow-hidden">
          <div class="absolute -top-32 left-1/2 -translate-x-1/2 w-96 sm:w-150 h-96 sm:h-150 rounded-full bg-primary opacity-[0.05] blur-3xl" />
          <div class="hidden sm:block absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-secondary opacity-[0.04] blur-3xl" />
        </div>

        {/* ─────────────── HERO ─────────────── */}
        <section class="flex flex-col items-center px-5 sm:px-6 pt-12 sm:pt-12 pb-12">
          {/* Solar system — desktop only */}
          <div class="hidden sm:flex animate-fade-up-1 relative items-center justify-center mb-8 mt-16">
            {PLANETS.map((p, i) => (
              <div
                key={i}
                class="absolute top-1/2 left-1/2 rounded-full border border-base-content/3 pointer-events-none"
                style={`width:${p.r * 2}px;height:${p.r * 2}px;margin-left:${-p
                  .r}px;margin-top:${-p
                  .r}px;animation:orbit ${p.duration} linear infinite`}
              >
                <span
                  class="absolute top-0 left-1/2 rounded-full"
                  style={`width:${p.size}px;height:${p.size}px;margin-left:${
                    -p.size / 2
                  }px;margin-top:${
                    -p.size / 2
                  }px;background:${p.color};box-shadow:0 0 ${p.size * 2}px ${
                    Math.round(p.size * 0.6)
                  }px ${p.color}99`}
                />
                {p.rings && (
                  <span
                    class="absolute top-0 left-1/2 rounded-full"
                    style={`width:${p.size * 2.6}px;height:${
                      p.size * 0.38
                    }px;margin-left:${-(p.size * 1.3)}px;margin-top:${-(p.size *
                      0.19)}px;background:${p.color}50;border:1px solid ${p.color}88`}
                  />
                )}
              </div>
            ))}
            <img
              src="/logo.svg"
              alt={title}
              class="relative z-10 w-40 h-40"
              style="filter: drop-shadow(0 0 32px oklch(var(--p)/0.5)) drop-shadow(0 0 80px oklch(var(--p)/0.25))"
            />
          </div>

          {/* Logo — mobile only */}
          <div class="sm:hidden animate-fade-up-1 mb-6">
            <img
              src="/logo.svg"
              alt={title}
              class="w-28 h-28"
              style="filter: drop-shadow(0 0 32px oklch(var(--p)/0.5)) drop-shadow(0 0 80px oklch(var(--p)/0.25))"
            />
          </div>

          <div class="animate-fade-up-2 text-center mb-2 mt-12">
            <h1 class="text-5xl lg:text-6xl font-bold tracking-tight leading-none inline-flex items-start gap-2 justify-center">
              {title.toUpperCase()}
              <span class="font-mono text-xs font-bold text-primary/70 mt-1.5 tracking-wider">
                v{version}
              </span>
            </h1>
            <p class="mt-3 text-base-content/50 text-sm tracking-[0.25em] uppercase font-bold">
              Job Queue · Type-Safe · Deno
            </p>
          </div>

          <p class="animate-fade-up-3 text-base-content/60 text-center max-w-lg text-base leading-relaxed mb-5">
            <span class="font-mono font-bold text-yellow-300 bg-primary px-1.5 py-0.5 rounded">
              Once queued, always delivered.
            </span>{" "}
            <span class="font-mono font-black text-primary">HOUND</span>{" "}
            doesn't drop jobs. Type-safe job queue for Deno with at-least-once
            delivery, cron scheduling, automatic retries, and a management REST
            API.
          </p>
        </section>

        {/* ─────────────── PERFORMANCE TABLE ─────────────── */}
        <section class="animate-fade-up-5 w-full max-w-4xl mx-auto px-5 sm:px-6 pb-20">
          <div class="rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/10 overflow-hidden">
            <div class="flex items-center gap-1.5 px-5 py-3 border-b border-zinc-800 bg-zinc-900">
              <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
              <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
              <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
              <span class="ml-2 text-xs text-zinc-400 font-mono">
                benchmark · Redis baremetal
              </span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 sm:divide-x divide-y sm:divide-y-0 divide-zinc-800">
              {BENCHMARKS.map(
                ({ label, jobs, throughput, duration, latency, tier }) => (
                  <div
                    key={label}
                    class={`px-5 py-6 font-mono text-[13px] ${
                      tier === "top" ? "bg-primary/5" : ""
                    }`}
                  >
                    <p
                      class={`text-[11px] uppercase tracking-[0.25em] mb-4 font-bold ${
                        tier === "top"
                          ? "text-primary"
                          : tier === "mid"
                          ? "text-zinc-400"
                          : "text-zinc-500"
                      }`}
                    >
                      {label}
                    </p>
                    <div class="space-y-1.5 mb-4">
                      <div class="flex justify-between gap-2">
                        <span class="text-zinc-500">jobs</span>
                        <span class="text-zinc-200">{jobs}</span>
                      </div>
                      <div class="flex justify-between gap-2">
                        <span class="text-zinc-500">time</span>
                        <span class="text-zinc-200">{duration}</span>
                      </div>
                      <div class="flex justify-between gap-2">
                        <span
                          class={tier === "top"
                            ? "text-primary font-bold"
                            : "text-zinc-500"}
                        >
                          tput
                        </span>
                        <span
                          class={tier === "top"
                            ? "text-primary font-bold"
                            : "text-zinc-200"}
                        >
                          {throughput}
                        </span>
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      {latency.map(([k, v]) => (
                        <div key={k} class="flex justify-between gap-2">
                          <span class="text-zinc-500">{k}:</span>
                          <span class="text-emerald-400">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
