# PRD: Generic Broker + User-Scoped Real-Time Relay

**Hushkey Internal Engineering · Status: Draft · Author: Leo Termine**

---

## Problem

Hushkey currently has two real-time delivery mechanisms that have grown
independently:

1. **`bookings.broker.ts` / `availability.broker.ts`** — per-domain Redis
   pub/sub brokers, each with their own `redisSub` listener,
   `Map<channel, Set<Listener>>`, subscribe/unsubscribe lifecycle, and publish
   helper. Pattern is correct but duplicated verbatim across domains.

2. **WebSocket relay (`ws.relay.ts`)** — `Map<userId, Set<WebSocket>>` backed by
   a separate Redis subscriber. Handles user-scoped push (notifications, inbox
   updates). Currently only reaches users by `userId`; no org-scoped or
   listing-scoped targeting.

The gap: there is **no unified primitive** for real-time delivery. Adding a new
domain (jobs vertical, messages, expressions) means copy-pasting another broker
file. Targeting a specific user from a non-WebSocket context (e.g., SSE for the
seeker dashboard) has no canonical path. Org-scoped delivery exists only inside
the bookings domain.

---

## Goals

- Single generic broker as the foundation for all Redis pub/sub in the app
- Domain brokers become thin 4-line wrappers — no more duplicated lifecycle code
- User-scoped relay that works for both WebSocket and SSE transports
- Targeting by `userId`, `orgId`, `listingId`, or any arbitrary key — caller
  decides the namespace
- Cross-machine delivery correct by default (Fly.io multi-node)
- No new infrastructure — Redis is the transport, same connection already
  operated

## Non-Goals

- Replacing Hound — broker handles real-time delivery, Hound handles durable job
  execution
- Message persistence / replay — broker is fire-and-forget; Hound + reaper owns
  replay
- NATS, WebSocket servers, or any new infra dependency
- Fan-out to external systems (webhooks etc.) — separate concern

---

## Architecture

### Layer 1 — Generic Broker (`packages/broker/broker.ts`)

The single Redis pub/sub primitive. Owns the `redisSub` dispatcher (registered
once), the `Map<channel, Set<Listener>>` registry, and the ref-counted
subscribe/unsubscribe lifecycle.

```
publish(channel, payload)         → redis.publish(channel, JSON.stringify(payload))
subscribe(channel, cb)            → returns unsub fn; auto-subscribes on first listener
                                    auto-unsubscribes on last listener leaving
```

All existing domain brokers (`bookings.broker.ts`, `availability.broker.ts`) are
refactored to import from here. No behaviour changes — purely structural.

**Key invariants:**

- One `redisSub` connection shared across all channels (not per-domain)
- `ensureDispatcher()` called once on first subscribe — guards against double
  registration
- Publish is best-effort; swallows transport errors (never poisons the write
  path)
- No type assumptions at this layer — `payload` is `unknown`, typed at domain
  wrapper

### Layer 2 — Domain Brokers (thin wrappers)

Each domain exports named helpers that encode its channel scheme. The entire
file is ~4-6 lines:

```typescript
// bookings.broker.ts
const ch = (orgId: string) => `bookings:org:${orgId}`;
export const subscribeToOrgBookings = (orgId, cb) =>
  subscribe<PublicDocument<Booking>>(ch(orgId), cb);
export const publishBookingChange = (b) => publish(ch(b.organisation_id), b);
```

Domains currently needing this treatment:

- `bookings.broker.ts` ✓ (exists, needs refactor to use generic broker)
- `availability.broker.ts` ✓ (exists, same)
- `expressions.broker.ts` — to be created when expressions gain real-time
  requirements
- `listings.broker.ts` — to be created for listing-status push to seeker
  dashboard

### Layer 3 — Real-Time Relay (`packages/broker/relay.ts`)

Bridges Redis pub/sub → in-process transport connections (WebSocket or SSE).
This is the layer that solves the user-scoped and org-scoped targeting gap.

**Design:**

```
registerSink(id, sink)   → registers a transport-agnostic write callback
                            first sink for an id: subscribes to relay:{id} on Redis
                            returns unsub fn; last sink leaving: unsubscribes from Redis

relayTo(id, payload)     → publish to relay:{id}
                            always goes through Redis — correct for multi-node
```

`id` is caller-controlled. Conventions:

| Target           | id                    |
| ---------------- | --------------------- |
| Specific user    | `userId`              |
| Org dashboard    | `org:{orgId}`         |
| Listing watchers | `listing:{listingId}` |
| Session          | `session:{sessionId}` |

**Transport adapters:**

WebSocket:

```typescript
const unsub = await registerSink(userId, (payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
});
req.signal.addEventListener("abort", () => unsub());
```

SSE:

```typescript
const unsub = await registerSink(userId, (payload) => {
  ctx.sse.send(JSON.stringify(payload));
});
req.signal.addEventListener("abort", () => unsub());
```

The relay doesn't know or care which transport the sink wraps. Adding a new
transport (long-poll, etc.) costs zero relay changes.

**Existing WebSocket relay migration:**

Current `ws.relay.ts` is already 80% of this. Migration is:

1. Replace `Map<userId, Set<WebSocket>>` + manual Redis subscription with
   `registerSink(userId, wsSink)`
2. Replace `publish(userId, event, data)` with
   `relayTo(userId, { event, data })`
3. Delete `ws.relay.ts` — relay.ts is the canonical implementation

### Channel Namespace Map

```
relay:{userId}              → user-scoped (WebSocket / SSE)
relay:org:{orgId}           → org dashboard push
relay:listing:{listingId}   → listing page live updates
bookings:org:{orgId}        → booking mutations → SSE dashboard feed
availability:{listingId}    → availability cache invalidation signals
```

No collisions. `relay:` prefix is owned by relay.ts; domain brokers use their
own prefixes.

---

## Data Flow

### Booking Created (current + post-refactor)

```
POST /api/private/bookings
  → service('bookings').createBooking()
  → invalidateAvailabilityCacheForListing()       // sync cache bust
  → publishBookingChange(booking)                  // broker: org SSE dashboard
  → relayTo(booking.seeker_id, { type: 'booking.created', booking }) // relay: seeker notification
  → hound.emitAsync('booking.created', { booking_id })               // hound: durable task fan-out
```

### Booking Confirmed (payment webhook)

```
Dodo payment.succeeded webhook
  → service('bookings').setStatus('confirmed')
  → publishBookingChange(booking)                  // broker: org SSE dashboard
  → relayTo(booking.seeker_id, { type: 'booking.confirmed', booking }) // relay: seeker notification  
  → hound.emitAsync('booking.confirmed', { booking_id })              // hound: email jobs etc.
```

### Seeker Dashboard SSE Connection

```
GET /api/private/sse/me
  → registerSink(userId, sseSink)                  // relay.ts
  → client receives real-time: booking updates, expression responses, messages
  → on disconnect: unsub() → relay cleans up Redis subscription if last listener
```

---

## File Structure

```
packages/
  broker/
    broker.ts          ← NEW: generic Redis pub/sub primitive
    relay.ts           ← NEW: transport-agnostic sink registry
    index.ts           ← re-exports { subscribe, publish, registerSink, relayTo }

packages/services/
  bookings/
    bookings.broker.ts ← REFACTOR: 4-line wrapper over broker.ts
  availability/
    availability.broker.ts ← REFACTOR: same
  expressions/
    expressions.broker.ts  ← NEW when needed
  listings/
    listings.broker.ts     ← NEW when needed

packages/plugins/
  ws.relay.ts          ← MIGRATE then DELETE (replaced by relay.ts)
```

---

## Implementation Sequence

### Phase 1 — Generic Broker (no behaviour change, pure refactor)

- [ ] Create `packages/broker/broker.ts` with generic `subscribe` / `publish`
- [ ] Refactor `bookings.broker.ts` to use it — verify SSE dashboard still works
- [ ] Refactor `availability.broker.ts` — verify availability invalidation still
      works
- [ ] Single `redisSub` shared; remove per-domain subscriber connections

### Phase 2 — Relay (`relay.ts`)

- [ ] Create `packages/broker/relay.ts` with `registerSink` / `relayTo`
- [ ] Migrate existing `ws.relay.ts` to use `registerSink` internally
- [ ] Add `relayTo(userId, ...)` calls to booking mutation handlers
- [ ] Verify WebSocket delivery still works end-to-end
- [ ] Delete `ws.relay.ts`

### Phase 3 — SSE Transport

- [ ] Create seeker SSE endpoint `/api/private/sse/me`
- [ ] Wire `registerSink(userId, sseSink)` in the SSE handler
- [ ] Connect seeker dashboard to SSE for booking status updates
- [ ] Publisher org dashboard SSE already works via `bookings.broker.ts` —
      verify no regression

### Phase 4 — Org-Scoped Relay (the gap identified)

- [ ] Add `relayTo('org:{orgId}', payload)` to booking mutation handlers
- [ ] Register org-scoped sinks in publisher dashboard SSE handler
- [ ] Allows publisher staff (multiple tabs, multiple staff) to receive live org
      updates without needing a shared userId

---

## Trade-offs and Decisions

**Why not NATS?** Redis pub/sub covers the delivery model. NATS adds
infrastructure for no functional gain at current scale. Revisit if Hushkey runs
>5 Fly machines and needs cross-region fan-out with JetStream semantics.

**Why broker is fire-and-forget (no retry)?** Real-time delivery to connected
clients is inherently best-effort — if the client disconnects the message is
irrelevant. Durable delivery with retry is Hound's job. The two do not overlap.

**Why relay always goes through Redis even for local sinks?** On Fly.io
multi-node, you cannot know which machine holds the target connection.
Publishing to Redis ensures the correct machine (whichever holds the
WebSocket/SSE connection for that userId) receives it. The local fast-path
optimisation is not worth the multi-node correctness bug.

**Why `id` is caller-controlled in relay.ts?** Avoids hardcoding a fixed key
schema into the relay primitive. New targeting strategies (listing-scoped,
session-scoped) cost zero relay changes. Convention is documented in this PRD
and enforced by code review.

**Why not merge broker.ts and relay.ts?** Separate concerns. `broker.ts` is a
generic pub/sub primitive usable by anything (domain brokers, relay, future
consumers). `relay.ts` is specifically about bridging to transport connections.
Merging them creates a god object.

---

## Success Criteria

- Zero duplicated Redis subscriber lifecycle code across domain broker files
- Adding a new domain broker costs ≤6 lines of code
- Seeker receives real-time booking status updates without polling
- Publisher org dashboard receives live booking feed (already works, preserved
  through refactor)
- Multi-node Fly.io deployment delivers to correct machine for userId-targeted
  relay
- `ws.relay.ts` deleted — one canonical relay implementation

---

## Out of Scope / Future

- **Missed message recovery**: client reconnect always hydrates from MongoDB,
  not from relay. If a message was missed during disconnect, the next page load
  fetches current state. No catch-up queue in relay.ts. If this becomes a
  product requirement, Hound + a `fetchRecentEvents` endpoint is the path — not
  relay.
- **Presence / typing indicators**: relay.ts could support this (send from
  client via HTTP, relay to org sink) but it's not a V1 requirement.
- **Message persistence in broker**: broker.ts is stateless. If audit trail of
  real-time events is needed, write to MongoDB in the mutation handler, not in
  the broker.
