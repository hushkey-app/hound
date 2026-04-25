import { Head } from "@hushkey/howl/runtime";
import type { Context } from "@hushkey/howl";
import type { State } from "../../howl.config.ts";
import type { JSX } from "preact/jsx-runtime";

export default function Index(
  _ctx: Context<State>,
): JSX.Element {
  // const stars = await getGithubStars();
  return (
    <>
      <Head>
        <title>Hound — Job Queue for Deno</title>
      </Head>

      <div class="relative min-h-screen bg-base-100 bg-dot-grid bg-size-[28px_28px] flex flex-col items-center justify-start overflow-hidden px-6 pt-24 pb-20">
        {/* Ambient glow blobs */}
        <div class="pointer-events-none absolute inset-0 overflow-hidden">
          <div class="absolute -top-32 left-1/2 -translate-x-1/2 w-150 h-150 rounded-full bg-primary opacity-[0.04] blur-3xl" />
          <div class="absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-secondary opacity-[0.04] blur-3xl" />
        </div>

        {/* Logo mark — Solar System */}
        <div class="animate-fade-up-1 relative flex items-center justify-center mb-8 mt-16">
          {[
            { r: 95, size: 7, color: "#9ca3af", duration: "4s", rings: false }, // Mercury
            { r: 122, size: 9, color: "#fbbf24", duration: "7s", rings: false }, // Venus
            {
              r: 150,
              size: 9,
              color: "#60a5fa",
              duration: "11s",
              rings: false,
            }, // Earth
            {
              r: 180,
              size: 8,
              color: "#f87171",
              duration: "18s",
              rings: false,
            }, // Mars
            {
              r: 232,
              size: 19,
              color: "#d97706",
              duration: "40s",
              rings: false,
            }, // Jupiter
            {
              r: 282,
              size: 14,
              color: "#fcd34d",
              duration: "80s",
              rings: true,
            }, // Saturn
            {
              r: 326,
              size: 11,
              color: "#67e8f9",
              duration: "140s",
              rings: false,
            }, // Uranus
            {
              r: 368,
              size: 11,
              color: "#3b82f6",
              duration: "200s",
              rings: false,
            }, // Neptune
            {
              r: 406,
              size: 5,
              color: "#c4b5fd",
              duration: "270s",
              rings: false,
            }, // Pluto
          ].map((p, i) => (
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

          {/* Logo / Sun */}
          <img
            src="/logo.svg"
            alt="Hound"
            class="relative z-10 w-36 h-36"
            style="filter: drop-shadow(0 0 32px oklch(var(--p)/0.5))"
          />
        </div>

        {/* Wordmark */}
        <div class="animate-fade-up-2 text-center mb-4">
          <h1 class="text-6xl sm:text-7xl font-bold tracking-tight leading-none">
            HOUND
          </h1>
          <p class="mt-4 text-base-content/50 text-base tracking-[0.25em] uppercase font-bold">
            Job Queue · Type-Safe · Deno
          </p>
        </div>

        {/* Tagline */}
        <p class="animate-fade-up-3 text-base-content/60 text-center max-w-lg text-lg leading-relaxed mb-10">
          At-least-once delivery, cron scheduling, automatic retries, and a
          management REST API — all in one Deno-native package.
        </p>

        {/* Quick Start — 4-step rotary grid */}
        <div class="animate-fade-up-4 w-full max-w-2xl mb-12">
          <p class="text-center font-black text-xs uppercase tracking-widest text-base-content/30 mb-7">
            Get started in minutes
          </p>

          {/* grid-rows fixes both step rows to the same height so all 4 boxes are equal */}
          <div class="grid grid-cols-[1fr_44px_1fr] grid-rows-[220px_auto_220px]">
            {/* ── Step 1: Install ── */}
            <div class="h-full flex flex-col rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
              <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300 shrink-0">
                <span class="w-2 h-2 rounded-full bg-error/60" />
                <span class="w-2 h-2 rounded-full bg-warning/60" />
                <span class="w-2 h-2 rounded-full bg-success/60" />
                <span class="ml-2 font-mono text-[11px] text-base-content/40">
                  01 · install
                </span>
              </div>
              <div class="flex-1 px-4 py-3.5 font-mono text-[13px] flex flex-col gap-2.5">
                <div>
                  <span class="text-primary/60 select-none">$</span>
                  <span class="text-base-content/75">deno add</span>
                  <span class="text-primary font-medium">
                    jsr:@hushkey/hound
                  </span>
                </div>
                <div class="text-base-content/20 select-none leading-none tracking-widest">
                  ─────────────────
                </div>
                <div class="text-base-content/50 leading-relaxed">
                  Redis · Deno KV · InMemory<br />
                  <span class="text-base-content/35">
                    pick your storage backend
                  </span>
                </div>
              </div>
            </div>

            {/* → */}
            <div class="flex items-center justify-center">
              <svg
                class="w-5 h-5 text-primary/70"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
                />
              </svg>
            </div>

            {/* ── Step 2: Create ── */}
            <div class="h-full flex flex-col rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
              <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300 shrink-0">
                <span class="w-2 h-2 rounded-full bg-error/60" />
                <span class="w-2 h-2 rounded-full bg-warning/60" />
                <span class="w-2 h-2 rounded-full bg-success/60" />
                <span class="ml-2 font-mono text-[11px] text-base-content/40">
                  02 · create
                </span>
              </div>
              <div class="flex-1 px-4 py-3.5 font-mono text-[13px] flex flex-col gap-1">
                <div class="text-base-content/35">
                  {"import { Hound, InMemoryStorage }"}
                </div>
                <div class="text-base-content/35 pl-2 mb-1">
                  {'  from "@hushkey/hound"'}
                </div>
                <div>
                  <span class="text-neutral/75">const</span>
                  <span class="text-base-content/75">hound = Hound</span>
                  <span class="text-primary font-medium">.create</span>
                  <span class="text-base-content/50">{"({"}</span>
                </div>
                <div class="pl-3">
                  <span class="text-base-content/45">db:</span>
                  <span class="text-success/70">new InMemoryStorage</span>
                  <span class="text-base-content/45">(),</span>
                </div>
                <div class="pl-3">
                  <span class="text-base-content/45">concurrency:</span>
                  <span class="text-neutral/80">10</span>
                  <span class="text-base-content/45">,</span>
                </div>
                <div class="text-base-content/50">{"}"}</div>
              </div>
            </div>

            {/* ↑ left  |  label  |  ↓ right */}
            <div class="flex items-center justify-center py-2">
              <svg
                class="w-5 h-5 text-primary/70 rotate-180"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
                />
              </svg>
            </div>
            <div class="flex items-center justify-center">
              <span class="font-mono text-[9px] text-primary/25 tracking-widest uppercase">
                4 steps
              </span>
            </div>
            <div class="flex items-center justify-center py-2">
              <svg
                class="w-5 h-5 text-primary/70"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
                />
              </svg>
            </div>

            {/* ── Step 4: Start & Emit ── */}
            <div class="h-full flex flex-col rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
              <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300 shrink-0">
                <span class="w-2 h-2 rounded-full bg-error/60" />
                <span class="w-2 h-2 rounded-full bg-warning/60" />
                <span class="w-2 h-2 rounded-full bg-success/60" />
                <span class="ml-2 font-mono text-[11px] text-base-content/40">
                  04 · start & emit
                </span>
              </div>
              <div class="flex-1 px-4 py-3.5 font-mono text-[13px] flex flex-col gap-1">
                <div>
                  <span class="text-neutral/75">await</span>
                  <span class="text-base-content/75">hound</span>
                  <span class="text-primary font-medium">.start</span>
                  <span class="text-base-content/50">()</span>
                </div>
                <div class="mt-1">
                  <span class="text-base-content/55">hound</span>
                  <span class="text-primary font-medium">.emit</span>
                  <span class="text-base-content/50">(</span>
                  <span class="text-success/70">"email.send"</span>
                  <span class="text-base-content/50">{", {"}</span>
                </div>
                <div class="pl-3">
                  <span class="text-base-content/45">to:</span>
                  <span class="text-success/70">"leo@hushkey.jp"</span>
                  <span class="text-base-content/45">,</span>
                </div>
                <div class="text-base-content/50">{"})"}</div>
                <div class="mt-auto text-base-content/35 text-[11px]">
                  returns jobId immediately
                </div>
              </div>
            </div>

            {/* ← */}
            <div class="flex items-center justify-center">
              <svg
                class="w-5 h-5 text-primary/70 rotate-180"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
                />
              </svg>
            </div>

            {/* ── Step 3: Register ── */}
            <div class="h-full flex flex-col rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
              <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300 shrink-0">
                <span class="w-2 h-2 rounded-full bg-error/60" />
                <span class="w-2 h-2 rounded-full bg-warning/60" />
                <span class="w-2 h-2 rounded-full bg-success/60" />
                <span class="ml-2 font-mono text-[11px] text-base-content/40">
                  03 · register handler
                </span>
              </div>
              <div class="flex-1 px-4 py-3.5 font-mono text-[13px] flex flex-col gap-1">
                <div>
                  <span class="text-base-content/55">hound</span>
                  <span class="text-primary font-medium">.on</span>
                  <span class="text-base-content/50">(</span>
                  <span class="text-success/70">"email.send"</span>
                  <span class="text-base-content/50">,</span>
                </div>
                <div class="pl-3">
                  <span class="text-neutral/75">async</span>
                  <span class="text-base-content/55">{"(ctx) => {"}</span>
                </div>
                <div class="pl-6 text-base-content/50">
                  await sendEmail(ctx.data.to)
                </div>
                <div class="pl-6 text-base-content/35">ctx.logger("sent!")</div>
                <div class="text-base-content/50">{"}, {"}</div>
                <div class="pl-3">
                  <span class="text-base-content/45">attempts:</span>
                  <span class="text-neutral/80">3</span>
                  <span class="text-base-content/45">,</span>
                </div>
                <div class="text-base-content/50">{"}"}</div>
              </div>
            </div>
          </div>
        </div>

        {/* CTA buttons */}
        {
          /* <div class="animate-fade-up-4flex flex-wrap gap-4 justify-center mb-20">
          <a href="/docs" class="btn btn-primary gap-2">
            Read the docs
            <span class="opacity-70">→</span>
          </a>
          <a
            href="https://github.com/mirairoad/hound"
            target="_blank"
            class="btn btn-outline gap-2"
          >
            GitHub
            <span class="opacity-50">↗</span>
          </a>
          <a
            href="https://jsr.io/@hushkey/hound"
            target="_blank"
            class="btn btn-ghost gap-2 text-base-content/50"
          >
            JSR
            <span class="opacity-50">↗</span>
          </a>
        </div> */
        }

        {/* Feature strip */}
        {
          /* <div class="animate-fade-up-5 w-full max-w-3xl">
          <div class="rounded-xl border border-base-300 bg-base-200/40 backdrop-blur overflow-hidden">
            <div class="grid grid-cols-2 sm:grid-cols-4 divide-base-300 divide-x divide-y sm:divide-y-0">
              {[
                { icon: "⚡", label: "At-Least-Once" },
                { icon: "🔒", label: "Type-Safe" },
                { icon: "⏰", label: "Cron Jobs" },
                { icon: "🔌", label: "REST API" },
              ].map((f) => (
                <div
                  key={f.label}
                  class="flex flex-col items-center gap-2 py-6 px-4"
                >
                  <span class="text-2xl">{f.icon}</span>
                  <span class="font-mono text-xs uppercase tracking-widest text-base-content/40">
                    {f.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div> */
        }

        {/* Benchmark */}
        <div class="animate-fade-up-5 w-full max-w-3xl mt-16">
          <div class="text-center mb-6">
            <p class="font-mono text-xs uppercase tracking-widest text-base-content/30 mb-2">
              Performance · MacBook Pro M1 Pro
            </p>
            <p class="font-mono font-black text-4xl text-primary tracking-tight">
              34,678{" "}
              <span class="text-2xl font-semibold text-base-content/50">
                jobs/s
              </span>
            </p>
            <p class="text-xs text-base-content/30 font-mono mt-1 tracking-widest uppercase">
              100,000 jobs · Redis · sub-millisecond handler
            </p>
          </div>

          <div class="rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
            <div class="flex items-center gap-1.5 px-5 py-3 border-b border-base-300">
              <span class="w-3 h-3 rounded-full bg-error/60" />
              <span class="w-3 h-3 rounded-full bg-warning/60" />
              <span class="w-3 h-3 rounded-full bg-success/60" />
              <span class="ml-2 text-sm text-base-content/30 font-mono">
                benchmark · Redis · M1 Pro
              </span>
            </div>

            <div class="grid grid-cols-3 divide-x divide-base-300">
              {[
                {
                  label: "1 core",
                  jobs: "100 jobs",
                  throughput: "425.21 jobs/s",
                  duration: "0.24s",
                  latency: [["min", "1.82ms"], ["p50", "2.03ms"], [
                    "p95",
                    "3.37ms",
                  ], ["avg", "2.35ms"]],
                  tier: "dim",
                },
                {
                  label: "10 cores",
                  jobs: "100 jobs",
                  throughput: "2,763.70 jobs/s",
                  duration: "0.04s",
                  latency: [["min", "1.80ms"], ["p50", "2.91ms"], [
                    "p95",
                    "7.98ms",
                  ], ["avg", "3.41ms"]],
                  tier: "mid",
                },
                {
                  label: "100k jobs",
                  jobs: "100,000 jobs",
                  throughput: "34,087.97 jobs/s",
                  duration: "2.93s",
                  latency: [["min", "6.00ms"], ["p50", "2073.00ms"], [
                    "p95",
                    "3207.00ms",
                  ], ["avg", "2058.51ms"]],
                  tier: "top",
                },
              ].map(({ label, jobs, throughput, duration, latency, tier }) => (
                <div
                  key={label}
                  class={`px-4 py-5 font-mono text-[12px] ${
                    tier === "dim"
                      ? "opacity-40"
                      : tier === "mid"
                      ? "opacity-70"
                      : ""
                  }`}
                >
                  <p
                    class={`text-xs uppercase tracking-widest mb-3 font-semibold ${
                      tier === "top" ? "text-primary" : "text-base-content/40"
                    }`}
                  >
                    {label}
                  </p>
                  <div class="space-y-1 mb-3">
                    <div class="flex justify-between gap-2">
                      <span class="text-base-content/40">jobs</span>
                      <span class="text-base-content/70">{jobs}</span>
                    </div>
                    <div class="flex justify-between gap-2">
                      <span class="text-base-content/40">time</span>
                      <span class="text-base-content/70">{duration}</span>
                    </div>
                    <div class="flex justify-between gap-2">
                      <span
                        class={tier === "top"
                          ? "text-primary font-semibold"
                          : "text-base-content/40"}
                      >
                        tput
                      </span>
                      <span
                        class={tier === "top"
                          ? "text-primary font-semibold"
                          : "text-base-content/70"}
                      >
                        {throughput}
                      </span>
                    </div>
                  </div>
                  <p class="text-base-content/15 mb-2 select-none">
                    ──────────────
                  </p>
                  <div class="space-y-1">
                    {latency.map(([k, v]) => (
                      <div key={k} class="flex justify-between gap-2">
                        <span class="text-base-content/30">{k}:</span>
                        <span class="text-success/70">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
