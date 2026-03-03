# PRD: VitePress Documentation Completion

Design is approved. Goal: **generate and complete the Markdown reference files**
for the major APIs so VitePress can serve full API docs. Tasks below are scoped
to the APIs in `core/types` and `core/libs` that matter for the docs.

---

## 1. VitePress config & nav

- [x] **1.1** Add Admin / AdminStore to reference sidebar in
      `www/docs/.vitepress/config.ts` (new item under API Reference linking to
      `/reference/admin-store`).
- [x] **1.2** Ensure reference index lists all four APIs: TaskManager, Consumer,
      Processor, AdminStore (update `www/docs/reference/index.md` if needed).

---

## 2. Task Manager API

**Source:** `core/types/task-manager.ts`,
`core/libs/task-manager/task-manager.ts`

- [x] **2.1** Create or rewrite `www/docs/reference/task-manager.md` so it
      matches the real API (remove placeholder `schedule()`; document
      `TaskManager.init()`, `registerHandler()`, `emit` via context, and
      `start()` / lifecycle).
- [x] **2.2** Document **types**: `JobHandler<T, D>`, `EmitFunction`,
      `TaskManagerOptions<T>`, `RegisterHandlerOptions<T, D>` (parameters,
      defaults, and where they are used).
- [x] **2.3** Document **emit options**: `event`, `queue`, `data`, and `options`
      (e.g. `id`, `priority`, `delayUntil`, `retryCount`, `retryDelayMs`,
      `repeat`, `attempts`, `debounce`) with short descriptions and examples
      where helpful.
- [x] **2.4** Add a minimal **code example** showing: `TaskManager.init()`, one
      `registerHandler()` call, and emitting a job from inside a handler or from
      outside.

---

## 3. Consumer API

**Source:** `core/types/consumer.ts`, `core/libs/consumer/consumer.ts`

- [x] **3.1** Rewrite `www/docs/reference/consumer.md` to reflect the actual
      Consumer: constructor with `ConsumerOptions`, `start()`, `stop()`, and
      event/handler-based flow (no fake `on('message')` if that’s not the real
      API).
- [x] **3.2** Document **ConsumerOptions** in full: `streams`, `streamdb`,
      `handler`, `concurrency`, `group`, `consumerId`, `pollIntervalMs`, `claim`
      (`minIdleMs`, `count`), `read` (`blockMs`, `count`) with types and
      defaults.
- [x] **3.3** Document the **MessageHandler** signature (from
      `core/types/message.ts`) as used by Consumer, and how it interacts with
      Consumer lifecycle.
- [x] **3.4** Add a minimal **code example**: building `ConsumerOptions`,
      creating a Consumer, and starting/stopping it.

---

## 4. Processor API

**Source:** `core/types/processor.ts`, `core/libs/processor/processor.ts`

- [x] **4.1** Rewrite `www/docs/reference/processor.md` so it describes
      Processor as the layer that wraps Consumer with retry, DLQ, and debounce
      (no placeholder `process(message)` if that’s not the public API).
- [x] **4.2** Document **ProcessorOptions**: `consumer`, `streamdb`, `retry`,
      `dlq`, `debounce`, `ignoreConfigErrors` and how they feed into the
      Processor.
- [x] **4.3** Document **RetryConfig**: `maxRetries`, `retryDelayMs`,
      `backoffMultiplier`, `shouldRetry` (and defaults).
- [x] **4.4** Document **DLQConfig**: `streamKey`, `shouldSendToDLQ` (and
      default behavior).
- [x] **4.5** Document **DebounceConfig** (and numeric shorthand): `debounce`,
      `keyFn` (and how Processor uses it).
- [x] **4.6** Document **ProcessableMessage** shape briefly (id, streamKey, data
      including delay/retry fields) so users know what the handler receives.
- [x] **4.7** Add a minimal **code example**: building Processor with Consumer
      options plus retry/DLQ/debounce, and starting it.

---

## 5. Admin Store API

**Source:** `core/libs/admin/admin-store.ts`, `core/types/admin.ts`

- [x] **5.1** Create `www/docs/reference/admin-store.md` and add it to the
      reference sidebar (see 1.1).
- [x] **5.2** Document **AdminStore** class: constructor (`db: RedisConnection`)
      and purpose (CRUD and control for admin UIs).
- [x] **5.3** Document **job methods**: `getJob(jobId, queue)`,
      `listJobs(options)`, `deleteJob(jobId, queue)` with params and return
      types; mention `ListJobsOptions` (`queue`, `status`, `limit`, `offset`).
- [x] **5.4** Document **queue methods**: `stats(queue)`, `queues()`,
      `queuesInfo()` and their return types (`TaskStats`, `QueueInfo`).
- [x] **5.5** Document **control methods**: `retryJob(jobId, queue)`,
      `cancelJob(jobId, queue)`, `pauseQueue(queue)`, `resumeQueue(queue)`,
      `isPaused(queue)`, `pauseJob(jobId, queue)`, `resumeJob(jobId, queue)`
      with behavior and errors (e.g. “only failed jobs can be retried”).
- [x] **5.6** Document **admin types**: `AdminJobData` (main fields: id, state,
      status, timestamps, logs, errors, paused), `ListJobsOptions`, `TaskStats`,
      `QueueInfo` in a small “Types” subsection or table.
- [x] **5.7** Add a minimal **code example**: instantiating AdminStore and
      calling 2–3 methods (e.g. `queuesInfo()`, `listJobs()`, `retryJob()`).

---

## 6. Cross-links and consistency

- [x] **6.1** In each reference page, add “Next steps” or “See also” links to
      the other three APIs (TaskManager, Consumer, Processor, AdminStore) where
      relevant.
- [x] **6.2** Use consistent heading levels and optional frontmatter (e.g.
      `title`, `description`) so the sidebar and meta look consistent.
- [x] **6.3** Ensure all code snippets use the same language tag (`ts` or
      `typescript`) and are import-path accurate for the repo (e.g. from
      `@core/` or as in examples).

---

## Summary: what it takes for VitePress to “finish off”

1. **Config:** One sidebar update to add AdminStore; optionally touch reference
   index.
2. **Four reference MD files:**
   - **Task Manager** – rewrite existing page to match real API + types + emit
     options + example.
   - **Consumer** – rewrite existing page to match real API + full
     ConsumerOptions + handler signature + example.
   - **Processor** – rewrite existing page to match real API + all option/config
     types + ProcessableMessage + example.
   - **Admin Store** – new page + types subsection + job/queue/control methods +
     example.
3. **Cross-links and style** – “See also” between reference pages and consistent
   headings/code style.

No design or theme changes required; only the Markdown content and one config
change.

---

## 7. README.md (repo root)

**Goal:** A proper README with installation and a simple up-and-running example
derived from `examples/`.

- [x] **7.1** Rewrite `README.md`: project name (REMQ), one-line description,
      and clear “What is REMQ?”.
- [x] **7.2** **Installation:** Document how to add/use REMQ (workspace:
      `@core/` from repo; when published: JSR/npm). Include Deno version and
      Redis prerequisite.
- [x] **7.3** **Up-and-running example:** One minimal flow from `examples/`:
      `TaskManager.init({ db, streamdb?, ... })`,
      `registerHandler({ event, handler, options? })`,
      `emit({ event, data, options? })`, `start()`. Code must be copy-pasteable
      and match `examples/tempotask.plugin.ts` +
      `examples/scheduler/onrequest.ts` + `examples/index.ts` pattern.
- [x] **7.4** **Running the examples:** How to run from repo (e.g.
      `deno task dev` or `deno run -A examples/index.ts`), with Redis running.
      Point to `examples/` for scheduler, crons, on-request handler.
- [x] **7.5** **Docs link:** Link to the VitePress docs site (or “docs in repo”
      path) and to API reference (TaskManager, Consumer, Processor, AdminStore).
- [x] **7.6** Remove or replace any TempoTask / tempotask / old JSR package
      names and URLs so they match REMQ and current repo.

---

## 8. Rebuild www/docs/guide/

**Goal:** Rebuild all guide pages so they match the real API, reuse reference
where appropriate, and pass acceptance criteria.

- [x] **8.1** **Guide index** (`www/docs/guide/index.md`): Keep “What is REMQ?”
      and quick nav; add short summaries that point to reference for API details
      (e.g. “Register handlers and emit jobs — see
      [TaskManager](/reference/task-manager).”).
- [x] **8.2** **Quick Start** (`www/docs/guide/quick-start.md`): Replace fake
      `new TaskManager` / `schedule()` with real flow: Redis connection,
      `TaskManager.init()`, one `registerHandler()`, `emit()`, `start()`. Reuse
      or mirror the minimal example from README / `examples/`. Link to
      [TaskManager reference](/reference/task-manager) and
      [Installation](/getting-started/installation).
- [x] **8.3** **Task Management** (`www/docs/guide/task-management.md`):
      Describe concepts (handlers, events, queues, emit options like
      delay/retry/repeat). Use real API only: `registerHandler()`, `emit()` with
      options. No `schedule()`. Add a short code snippet that matches reference;
      link to [TaskManager API](/reference/task-manager) for full options.
- [x] **8.4** **Message Queues** (`www/docs/guide/message-queues.md`): Describe
      queues, streams, producer/consumer in REMQ terms. Use real APIs:
      TaskManager as producer (emit), Consumer/Processor as consumer. No fake
      `consumer.on('message')`. Link to [Consumer](/reference/consumer) and
      [Processor](/reference/processor).
- [x] **8.5** **Consumers** (`www/docs/guide/consumers.md`): Describe how
      consumers work (streams, handler, ConsumerOptions). Use real API:
      `Consumer` with `streams`, `streamdb`, `handler`; or Processor wrapping
      Consumer. Link to [Consumer API](/reference/consumer) and
      [Processor API](/reference/processor) for full options and examples.
- [x] **8.6** Optional: add **Admin / dashboard** guide page that introduces
      AdminStore and links to [AdminStore reference](/reference/admin-store); or
      a short “Job management” subsection in an existing page with link to
      reference.

---

## 9. Wiring docs (nav, links, consistency)

**Goal:** Ensure docs site is wired so users can get started and jump to
reference.

- [x] **9.1** **Home** (`www/docs/index.md`): “Get Started” →
      `/guide/quick-start`; “Documentation” → `/guide/`. Ensure hero and
      features match REMQ (no TempoTask).
- [x] **9.2** **Getting Started:** Installation and Quick Start linked from
      sidebar and guide index. Installation must state the same install method
      as README (workspace vs JSR) and Redis setup.
- [x] **9.3** **Guide → Reference:** Every guide page has at least one “See
      also” or “Full API” link to the relevant reference page(s). Reference
      pages already link to each other.
- [x] **9.4** **Sidebar:** Guide sidebar lists Quick Start, Task Management,
      Message Queues, Consumers (and optional Admin). Reference sidebar lists
      TaskManager, Consumer, Processor, AdminStore. No broken links.
- [x] **9.5** **Config:** If repo name/URL is REMQ, update
      `www/docs/.vitepress/config.ts` nav links (GitHub, JSR) to REMQ
      repo/package when applicable.

---

## 10. Acceptance criteria (validation)

**Goal:** All documented information is valid and consistent.

- [x] **10.1** **Package / import names:** Every code sample and install
      instruction uses a single, consistent story (e.g. workspace `@core/` for
      repo, or JSR/npm for “published” docs). No leftover TempoTask/tempotask
      package names in README or www/docs.
- [x] **10.2** **API surface:** No references to non-existent APIs (e.g.
      `schedule()`, `new TaskManager()`, `consumer.on('message')`). Only real
      APIs: `TaskManager.init()`, `registerHandler()`, `emit()`, `start()`,
      `Consumer` constructor + `start()`/`stop()`, Processor constructor +
      start, AdminStore methods.
- [x] **10.3** **Code samples:** At least the README and Quick Start examples
      are runnable when Redis is up and dependencies are installed (same pattern
      as `examples/index.ts` + plugin).
- [x] **10.4** **Links:** All internal links in README and www/docs (guide,
      reference, getting-started) resolve to existing pages. No 404s.
- [x] **10.5** **Reference vs guide:** Guide explains concepts and points to
      reference for options/types; reference remains the source of truth for API
      details. No contradictory claims between guide and reference.

---

## Summary: extra work to “finish off” (README, guide, wiring, validation)

| Area           | Tasks                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **README**     | Rewrite README with REMQ name, installation (workspace/JSR), one up-and-running example from `examples/`, how to run examples, docs link; remove TempoTask references. |
| **Guide**      | Rebuild `guide/index`, `quick-start`, `task-management`, `message-queues`, `consumers` to use real API only; reuse/link to reference; optional Admin subsection.       |
| **Wiring**     | Home + getting-started + sidebar links correct; guide ↔ reference cross-links; config nav (GitHub/JSR) aligned with REMQ.                                              |
| **Acceptance** | Single package/import story; no fake APIs in docs; README + Quick Start examples runnable; no broken links; guide and reference consistent.                            |
