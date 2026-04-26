import { Head } from "@hushkey/howl/runtime";
import type { Context } from "@hushkey/howl";
import type { State } from "../../howl.config.ts";
import type { JSX } from "preact/jsx-runtime";

function MobileStepCard(
  { n, label, children }: {
    n: string;
    label: string;
    children: JSX.Element | JSX.Element[];
  },
) {
  return (
    <div class="border border-base-300 rounded-xl bg-base-200/70 overflow-hidden mx-4">
      <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300">
        <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
        <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
        <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
        <span class="ml-1.5 font-mono text-[11px] font-semibold text-base-content/50 uppercase tracking-widest">
          {n} · {label}
        </span>
      </div>
      <div class="px-4 py-3.5 font-mono text-[13px] leading-relaxed flex flex-col gap-1.5">
        {children}
      </div>
    </div>
  );
}

function StepArrow() {
  return (
    <div class="flex justify-center py-1">
      <svg class="w-5 h-5 text-primary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75" />
      </svg>
    </div>
  );
}

export default function Index(_ctx: Context<State>): JSX.Element {
  return (
    <>
      <Head>
        <title>Hound — Job Queue for Deno</title>
        <meta name="description" content="Type-safe background jobs, queues, and cron for Deno. Redis, KV, and in-memory storage." />
        <meta property="og:title" content="Hound — Job Queue for Deno" />
        <meta property="og:description" content="Type-safe background jobs, queues, and cron for Deno. Redis, KV, and in-memory storage." />
        <meta property="og:image" content="https://hound.hushkey.dev/og-image.png" />
        <meta property="og:url" content="https://hound.hushkey.dev" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Hound — Job Queue for Deno" />
        <meta name="twitter:description" content="Type-safe background jobs, queues, and cron for Deno. Redis, KV, and in-memory storage." />
        <meta name="twitter:image" content="https://hound.hushkey.dev/og-image.png" />
      </Head>

      {/* ─────────────── MOBILE ─────────────── */}
      <div class="sm:hidden relative min-h-screen bg-base-100 bg-dot-grid bg-size-[28px_28px] flex flex-col overflow-hidden pt-20 pb-6">
        <div class="pointer-events-none absolute inset-0 overflow-hidden">
          <div class="absolute -top-32 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-primary opacity-[0.06] blur-3xl" />
        </div>

        {/* Hero */}
        <div class="animate-fade-up-1 flex items-center justify-center mb-3 px-5">
          <img src="/logo.svg" alt="Hound" class="w-24 h-24" style="filter: drop-shadow(0 0 24px oklch(var(--p)/0.5))" />
        </div>

        <div class="animate-fade-up-2 text-center mb-2 px-5">
          <h1 class="text-6xl font-bold tracking-tight leading-none">HOUND</h1>
          <p class="mt-2.5 text-base-content/60 text-[11px] font-bold tracking-[0.25em] uppercase">
            Job Queue · Type-Safe · Deno
          </p>
        </div>

        <p class="animate-fade-up-3 text-base-content/70 text-center text-base leading-relaxed mb-6 px-6">
          At-least-once delivery, cron scheduling, automatic retries, and a
          management REST API — all in one Deno-native package.
        </p>

        {/* CTAs */}
        <div class="animate-fade-up-3 flex flex-col gap-2.5 mb-10 px-5">
          <a href="/docs" class="btn btn-primary btn-md w-full text-base font-bold rounded-xl">
            Read the docs →
          </a>
          <a href="https://github.com/mirairoad/hound" target="_blank" class="btn btn-outline btn-md w-full rounded-xl text-base">
            GitHub
          </a>
        </div>

        {/* Quick start steps */}
        <div class="animate-fade-up-4 w-full mb-10">
          <p class="text-center font-black text-[11px] uppercase tracking-widest text-base-content/40 mb-5 px-5">
            Get started in 4 steps
          </p>

          <div class="flex flex-col gap-1">
            <MobileStepCard n="01" label="install">
              <div>
                <span class="text-primary/70 select-none">$ </span>
                <span class="text-base-content/80">deno add </span>
                <span class="text-primary font-semibold">jsr:@hushkey/hound</span>
              </div>
              <div class="text-base-content/50 text-[12px] mt-1">
                Redis · Deno KV · InMemory — pick your storage backend
              </div>
            </MobileStepCard>

            <StepArrow />

            <MobileStepCard n="02" label="create">
              <div class="text-base-content/40 text-[12px] mb-1">
                import {"{ Hound, InMemoryStorage }"} from "@hushkey/hound"
              </div>
              <div>
                <span class="text-base-content/60">const </span>
                <span class="text-base-content/85">hound = Hound</span>
                <span class="text-primary font-semibold">.create</span>
                <span class="text-base-content/60">{"({"}</span>
              </div>
              <div class="pl-4">
                <span class="text-base-content/60">db: </span>
                <span class="text-success font-semibold">new InMemoryStorage</span>
                <span class="text-base-content/60">(),</span>
              </div>
              <div class="pl-4">
                <span class="text-base-content/60">concurrency: </span>
                <span class="text-warning font-semibold">10</span>
                <span class="text-base-content/60">,</span>
              </div>
              <div class="text-base-content/60">{"}"}</div>
            </MobileStepCard>

            <StepArrow />

            <MobileStepCard n="03" label="register handler">
              <div>
                <span class="text-base-content/85">hound</span>
                <span class="text-primary font-semibold">.on</span>
                <span class="text-base-content/60">(</span>
                <span class="text-success font-semibold">"email.send"</span>
                <span class="text-base-content/60">,</span>
              </div>
              <div class="pl-4">
                <span class="text-base-content/60">async </span>
                <span class="text-base-content/70">{"(ctx) => {"}</span>
              </div>
              <div class="pl-8 text-base-content/60">await sendEmail(ctx.data.to)</div>
              <div class="text-base-content/60">{"}, { attempts: 3 }"}</div>
            </MobileStepCard>

            <StepArrow />

            <MobileStepCard n="04" label="start & emit">
              <div>
                <span class="text-base-content/60">await </span>
                <span class="text-base-content/85">hound</span>
                <span class="text-primary font-semibold">.start</span>
                <span class="text-base-content/60">()</span>
              </div>
              <div>
                <span class="text-base-content/85">hound</span>
                <span class="text-primary font-semibold">.emit</span>
                <span class="text-base-content/60">(</span>
                <span class="text-success font-semibold">"email.send"</span>
                <span class="text-base-content/60">{", {"}</span>
              </div>
              <div class="pl-4">
                <span class="text-base-content/60">to: </span>
                <span class="text-success font-semibold">"leo@hushkey.jp"</span>
                <span class="text-base-content/60">,</span>
              </div>
              <div class="text-base-content/60">{"})"}</div>
              <div class="text-base-content/40 text-[11px] pt-1">returns jobId immediately</div>
            </MobileStepCard>
          </div>
        </div>

        {/* Benchmark */}
        <div class="animate-fade-up-5 w-full mt-4 px-4">
          <div class="text-center mb-5">
            <p class="font-mono text-[11px] uppercase tracking-widest text-base-content/40 mb-2">
              Performance · M1 Pro · Redis
            </p>
            <p class="font-mono font-black text-5xl text-primary tracking-tight leading-none">
              34,678
            </p>
            <p class="font-mono text-base font-semibold text-base-content/60 mt-2">jobs / second</p>
            <p class="text-[11px] text-base-content/40 font-mono mt-1.5 uppercase tracking-widest">
              100,000 jobs · sub-millisecond handler
            </p>
          </div>

          <div class="rounded-xl border border-base-300 bg-base-200/70 overflow-hidden">
            <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-base-300">
              <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
              <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
              <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
              <span class="ml-1.5 text-[11px] text-base-content/50 font-mono uppercase tracking-widest">100k jobs · Redis · M1 Pro</span>
            </div>
            <div class="px-5 py-5 font-mono text-[13px]">
              <p class="text-[11px] font-bold text-primary uppercase tracking-widest mb-4">100k jobs</p>
              <div class="space-y-2">
                <div class="flex justify-between">
                  <span class="text-base-content/60">jobs</span>
                  <span class="text-base-content/85 font-medium">100,000</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-base-content/60">duration</span>
                  <span class="text-base-content/85 font-medium">2.93s</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-primary font-bold">throughput</span>
                  <span class="text-primary font-bold">34,087 jobs/s</span>
                </div>
              </div>
              <div class="border-t border-base-300 mt-4 pt-4 space-y-2">
                {[["min", "6.00ms"], ["p50", "2073ms"], ["p95", "3207ms"], ["avg", "2058ms"]].map(
                  ([k, v]) => (
                    <div key={k} class="flex justify-between">
                      <span class="text-base-content/50">{k}:</span>
                      <span class="text-success font-semibold">{v}</span>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─────────────── DESKTOP ─────────────── */}
      <div class="hidden sm:block relative min-h-screen bg-base-100 bg-dot-grid bg-size-[28px_28px] overflow-hidden">
        <div class="pointer-events-none absolute inset-0 overflow-hidden">
          <div class="absolute -top-32 left-1/2 -translate-x-1/2 w-150 h-150 rounded-full bg-primary opacity-[0.04] blur-3xl" />
          <div class="absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-secondary opacity-[0.04] blur-3xl" />
        </div>

        <div class="flex flex-col items-center px-6 pt-32 pb-20">
          {/* Solar System */}
          <div class="animate-fade-up-1 relative flex items-center justify-center mb-8 mt-16">
            {[
              { r: 95, size: 7, color: "#9ca3af", duration: "4s", rings: false },
              { r: 122, size: 9, color: "#fbbf24", duration: "7s", rings: false },
              { r: 150, size: 9, color: "#60a5fa", duration: "11s", rings: false },
              { r: 180, size: 8, color: "#f87171", duration: "18s", rings: false },
              { r: 232, size: 19, color: "#d97706", duration: "40s", rings: false },
              { r: 282, size: 14, color: "#fcd34d", duration: "80s", rings: true },
              { r: 326, size: 11, color: "#67e8f9", duration: "140s", rings: false },
              { r: 368, size: 11, color: "#3b82f6", duration: "200s", rings: false },
              { r: 406, size: 5, color: "#c4b5fd", duration: "270s", rings: false },
            ].map((p, i) => (
              <div
                key={i}
                class="absolute top-1/2 left-1/2 rounded-full border border-base-content/3 pointer-events-none"
                style={`width:${p.r * 2}px;height:${p.r * 2}px;margin-left:${-p.r}px;margin-top:${-p.r}px;animation:orbit ${p.duration} linear infinite`}
              >
                <span
                  class="absolute top-0 left-1/2 rounded-full"
                  style={`width:${p.size}px;height:${p.size}px;margin-left:${-p.size / 2}px;margin-top:${-p.size / 2}px;background:${p.color};box-shadow:0 0 ${p.size * 2}px ${Math.round(p.size * 0.6)}px ${p.color}99`}
                />
                {p.rings && (
                  <span
                    class="absolute top-0 left-1/2 rounded-full"
                    style={`width:${p.size * 2.6}px;height:${p.size * 0.38}px;margin-left:${-(p.size * 1.3)}px;margin-top:${-(p.size * 0.19)}px;background:${p.color}50;border:1px solid ${p.color}88`}
                  />
                )}
              </div>
            ))}
            <img src="/logo.svg" alt="Hound" class="relative z-10 w-36 h-36" style="filter: drop-shadow(0 0 32px oklch(var(--p)/0.5))" />
          </div>

          <div class="animate-fade-up-2 text-center mb-4">
            <h1 class="text-6xl lg:text-7xl font-bold tracking-tight leading-none">HOUND</h1>
            <p class="mt-4 text-base-content/50 text-base tracking-[0.25em] uppercase font-bold">
              Job Queue · Type-Safe · Deno
            </p>
          </div>

          <p class="animate-fade-up-3 text-base-content/60 text-center max-w-lg text-lg leading-relaxed mb-10">
            At-least-once delivery, cron scheduling, automatic retries, and a
            management REST API — all in one Deno-native package.
          </p>

          {/* Quick Start rotary grid */}
          <div class="animate-fade-up-4 w-full max-w-4xl mb-16">
            <p class="text-center font-black text-xs uppercase tracking-[0.3em] text-base-content/40 mb-8">
              Get started in minutes
            </p>
            <div class="grid grid-cols-[1fr_56px_1fr] grid-rows-[260px_auto_260px] gap-y-1">
              {/* 01 · install */}
              <div class="h-full flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/5 overflow-hidden">
                <div class="flex items-center gap-1.5 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
                  <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
                  <span class="ml-2 font-mono text-xs text-zinc-400">01 · install</span>
                </div>
                <div class="flex-1 px-5 py-5 font-mono text-[14px] flex flex-col gap-3">
                  <div>
                    <span class="text-violet-400 select-none">$</span>
                    <span class="text-zinc-200"> deno add</span>
                  </div>
                  <div class="text-emerald-400 font-medium pl-3">jsr:@hushkey/hound</div>
                  <div class="text-zinc-700 select-none leading-none tracking-widest">─────────────────</div>
                  <div class="text-zinc-400 leading-relaxed text-[13px]">
                    Redis · Deno KV · InMemory<br />
                    <span class="text-zinc-500">pick your storage backend</span>
                  </div>
                </div>
              </div>
              <div class="flex items-center justify-center">
                <svg class="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
              </div>
              {/* 02 · create */}
              <div class="h-full flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/5 overflow-hidden">
                <div class="flex items-center gap-1.5 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
                  <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
                  <span class="ml-2 font-mono text-xs text-zinc-400">02 · create</span>
                </div>
                <div class="flex-1 px-5 py-5 font-mono text-[14px] flex flex-col gap-1.5">
                  <div>
                    <span class="text-violet-400">import</span>
                    <span class="text-zinc-200">{" { "}</span>
                    <span class="text-cyan-400">Hound</span>
                    <span class="text-zinc-200">, </span>
                    <span class="text-cyan-400">InMemoryStorage</span>
                    <span class="text-zinc-200">{" } "}</span>
                  </div>
                  <div class="pl-3 mb-1">
                    <span class="text-violet-400">from</span>
                    <span class="text-emerald-400"> "@hushkey/hound"</span>
                  </div>
                  <div>
                    <span class="text-violet-400">const</span>
                    <span class="text-zinc-200"> hound = </span>
                    <span class="text-cyan-400">Hound</span>
                    <span class="text-zinc-200">.</span>
                    <span class="text-amber-400">create</span>
                    <span class="text-zinc-200">{"({"}</span>
                  </div>
                  <div class="pl-4">
                    <span class="text-zinc-300">db:</span>
                    <span class="text-violet-400"> new </span>
                    <span class="text-cyan-400">InMemoryStorage</span>
                    <span class="text-zinc-200">(),</span>
                  </div>
                  <div class="pl-4">
                    <span class="text-zinc-300">concurrency:</span>
                    <span class="text-amber-400"> 10</span>
                    <span class="text-zinc-200">,</span>
                  </div>
                  <div class="text-zinc-200">{"})"}</div>
                </div>
              </div>
              <div class="flex items-center justify-center py-2">
                <svg class="w-6 h-6 text-primary rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75" />
                </svg>
              </div>
              <div class="flex items-center justify-center">
                <span class="font-mono text-[10px] text-primary/40 tracking-[0.3em] uppercase">4 steps</span>
              </div>
              <div class="flex items-center justify-center py-2">
                <svg class="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75" />
                </svg>
              </div>
              {/* 04 · start & emit */}
              <div class="h-full flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/5 overflow-hidden">
                <div class="flex items-center gap-1.5 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
                  <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
                  <span class="ml-2 font-mono text-xs text-zinc-400">04 · start & emit</span>
                </div>
                <div class="flex-1 px-5 py-5 font-mono text-[14px] flex flex-col gap-1.5">
                  <div>
                    <span class="text-violet-400">await</span>
                    <span class="text-zinc-200"> hound.</span>
                    <span class="text-amber-400">start</span>
                    <span class="text-zinc-200">()</span>
                  </div>
                  <div class="mt-2">
                    <span class="text-zinc-200">hound.</span>
                    <span class="text-amber-400">emit</span>
                    <span class="text-zinc-200">(</span>
                    <span class="text-emerald-400">"email.send"</span>
                    <span class="text-zinc-200">{", {"}</span>
                  </div>
                  <div class="pl-4">
                    <span class="text-zinc-300">to:</span>
                    <span class="text-emerald-400"> "leo@hushkey.jp"</span>
                    <span class="text-zinc-200">,</span>
                  </div>
                  <div class="text-zinc-200">{"})"}</div>
                  <div class="mt-auto text-zinc-500 text-[12px] pt-3 border-t border-zinc-800/60">
                    <span class="text-success/80">→</span> returns jobId immediately
                  </div>
                </div>
              </div>
              <div class="flex items-center justify-center">
                <svg class="w-6 h-6 text-primary rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
              </div>
              {/* 03 · register handler */}
              <div class="h-full flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/5 overflow-hidden">
                <div class="flex items-center gap-1.5 px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
                  <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
                  <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
                  <span class="ml-2 font-mono text-xs text-zinc-400">03 · register handler</span>
                </div>
                <div class="flex-1 px-5 py-5 font-mono text-[14px] flex flex-col gap-1.5">
                  <div>
                    <span class="text-zinc-200">hound.</span>
                    <span class="text-amber-400">on</span>
                    <span class="text-zinc-200">(</span>
                    <span class="text-emerald-400">"email.send"</span>
                    <span class="text-zinc-200">,</span>
                  </div>
                  <div class="pl-4">
                    <span class="text-violet-400">async </span>
                    <span class="text-zinc-200">{"(ctx) => {"}</span>
                  </div>
                  <div class="pl-8 text-zinc-300">
                    <span class="text-violet-400">await</span> sendEmail(ctx.data.to)
                  </div>
                  <div class="pl-8 text-zinc-500">ctx.logger(<span class="text-emerald-400">"sent!"</span>)</div>
                  <div class="text-zinc-200">{"}, {"}</div>
                  <div class="pl-4">
                    <span class="text-zinc-300">attempts:</span>
                    <span class="text-amber-400"> 3</span>
                    <span class="text-zinc-200">,</span>
                  </div>
                  <div class="text-zinc-200">{"})"}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Benchmark */}
          <div class="animate-fade-up-5 w-full max-w-4xl mt-20">
            <div class="text-center mb-8">
              <p class="font-mono text-xs uppercase tracking-[0.3em] text-base-content/40 mb-3">
                Performance · MacBook Pro M1 Pro
              </p>
              <p class="font-mono font-black text-6xl text-primary tracking-tight leading-none">
                34,678
                <span class="text-2xl font-semibold text-base-content/60 ml-3">jobs/s</span>
              </p>
              <p class="text-xs text-base-content/40 font-mono mt-3 tracking-[0.25em] uppercase">
                100,000 jobs · Redis · sub-millisecond handler
              </p>
            </div>
            <div class="rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-primary/10 overflow-hidden">
              <div class="flex items-center gap-1.5 px-5 py-3 border-b border-zinc-800 bg-zinc-900">
                <span class="w-2.5 h-2.5 rounded-full bg-error/70" />
                <span class="w-2.5 h-2.5 rounded-full bg-warning/70" />
                <span class="w-2.5 h-2.5 rounded-full bg-success/70" />
                <span class="ml-2 text-xs text-zinc-400 font-mono">benchmark · Redis · M1 Pro</span>
              </div>
              <div class="grid grid-cols-3 divide-x divide-zinc-800">
                {[
                  {
                    label: "1 core", jobs: "100 jobs", throughput: "425.21 jobs/s", duration: "0.24s",
                    latency: [["min", "1.82ms"], ["p50", "2.03ms"], ["p95", "3.37ms"], ["avg", "2.35ms"]],
                    tier: "dim",
                  },
                  {
                    label: "10 cores", jobs: "100 jobs", throughput: "2,763.70 jobs/s", duration: "0.04s",
                    latency: [["min", "1.80ms"], ["p50", "2.91ms"], ["p95", "7.98ms"], ["avg", "3.41ms"]],
                    tier: "mid",
                  },
                  {
                    label: "100k jobs", jobs: "100,000 jobs", throughput: "34,087.97 jobs/s", duration: "2.93s",
                    latency: [["min", "6.00ms"], ["p50", "2073.00ms"], ["p95", "3207.00ms"], ["avg", "2058.51ms"]],
                    tier: "top",
                  },
                ].map(({ label, jobs, throughput, duration, latency, tier }) => (
                  <div
                    key={label}
                    class={`px-5 py-6 font-mono text-[13px] ${tier === "top" ? "bg-primary/5" : ""}`}
                  >
                    <p class={`text-[11px] uppercase tracking-[0.25em] mb-4 font-bold ${tier === "top" ? "text-primary" : tier === "mid" ? "text-zinc-400" : "text-zinc-500"}`}>
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
                        <span class={tier === "top" ? "text-primary font-bold" : "text-zinc-500"}>tput</span>
                        <span class={tier === "top" ? "text-primary font-bold" : "text-zinc-200"}>{throughput}</span>
                      </div>
                    </div>
                    <p class="text-zinc-800 mb-3 select-none tracking-widest">──────────────</p>
                    <div class="space-y-1.5">
                      {latency.map(([k, v]) => (
                        <div key={k} class="flex justify-between gap-2">
                          <span class="text-zinc-500">{k}:</span>
                          <span class="text-emerald-400">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
