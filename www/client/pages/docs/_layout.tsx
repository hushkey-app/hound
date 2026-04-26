import type { PageProps } from "@hushkey/howl";
import type { State } from "../../../howl.config.ts";
import { readManifest } from "../../../server/docs/reader.ts";
import type { JSX } from "preact/jsx-runtime";

export default function DocsLayout(
  { Component, url }: PageProps<unknown, State>,
): JSX.Element {
  const manifest = readManifest();
  const segments = url.pathname.replace(/\/$/, "").split("/");
  const currentSlug = segments[segments.length - 1] === "docs"
    ? ""
    : segments[segments.length - 1];

  return (
    <div class="relative min-h-screen bg-base-100 bg-dot-grid bg-size-[28px_28px]">
      {/* Ambient glow */}
      <div class="pointer-events-none fixed inset-0 overflow-hidden">
        <div class="absolute -top-32 left-1/2 -translate-x-1/2 w-150 h-150 rounded-full bg-primary opacity-[0.04] blur-3xl" />
        <div class="absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-secondary opacity-[0.04] blur-3xl" />
      </div>

      {/* Sidebar + content — pt clears the brand bar (mobile ~64px, desktop ~88px) */}
      <div class="flex pt-20 sm:pt-24">
        <aside class="hidden lg:flex w-64 shrink-0 flex-col border-r border-base-300 fixed top-24 bottom-0 overflow-y-auto bg-base-100/60 backdrop-blur">
          <div class="p-4">
            <p class="font-mono text-xs uppercase tracking-widest text-base-content/30 mb-3 px-2">
              Documentation
            </p>
            <ul class="menu gap-1 p-0">
              {manifest.map((item) => {
                const isActive = item.slug === currentSlug;
                return (
                  <li key={item.slug}>
                    <a
                      href={`/docs/${item.slug}`}
                      class={`rounded-lg text-base py-2.5 px-3 ${
                        isActive
                          ? "bg-primary/10 text-primary font-semibold"
                          : "text-base-content/70 hover:text-base-content hover:bg-base-200"
                      }`}
                    >
                      {item.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/*
          Mobile bottom padding:
          - < sm: root bottom nav (~64px) + this doc strip (~56px) → pb-32
          - sm – lg: only this strip → pb-20
          - lg+: sidebar only → pb-0
        */}
        <div class="flex-1 lg:ml-64 min-w-0 px-4 sm:px-6 lg:px-8 pb-32 sm:pb-20 lg:pb-0">
          <Component />
        </div>
      </div>

      {/*
        Doc page scroll strip — sits ABOVE the root bottom tab bar on mobile.
        Root nav is sm:hidden (gone at ≥640px), so strip only needs to lift at <sm.
      */}
      <div class="lg:hidden fixed bottom-(--nav-h) sm:bottom-0 left-0 right-0 z-40 bg-base-100/95 backdrop-blur border-t border-base-300 px-3 py-2 overflow-x-auto scrollbar-hide">
        <ul class="flex gap-2 min-w-max">
          {manifest.map((item) => {
            const isActive = item.slug === currentSlug;
            return (
              <li key={item.slug}>
                <a
                  href={`/docs/${item.slug}`}
                  class={`btn btn-sm rounded-lg font-mono text-xs ${isActive ? "btn-primary" : "btn-ghost"}`}
                >
                  {item.title}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
