# 0001 — State store: keep single-document compare-and-set for M1

- Status: accepted (M0 / S4)
- Scope: durable JSON state (`agent/lib/store`). Binary objects (`putBytes`) are out of scope; they are unversioned, last write wins (`agent/lib/store/kv.ts:29`).

## Context

M1–M3 add runs with lease fencing, an approval/action ledger, budget reservations, an event inbox and a delivery outbox (IMPLEMENTATION_PLAN.md §3, M1 F1/F5/F7). S4 asks whether the existing store can hold these invariants, or whether hosted state needs a transactional database.

The store is a small versioned key-value contract (`kv.ts:23-32`): `get` returns `{value, version}`; `put` takes `expectedVersion` (`undefined` = unconditional, `null` = create only, string = must match, `kv.ts:14-21`); `delete` and `list(prefix)` take no condition. `updateDoc` (`index.ts:108-129`) is the read-modify-write primitive: it takes an in-process per-key lock (`index.ts:83-98`), reads, runs a pure `mutate` (returning `null` abandons the write), writes with the version it read, and on conflict backs off and retries, 5 attempts by default, then throws.

There is no KV/Redis backend: `kv.ts` is only the interface. Backends are picked by `store()` (`index.ts:25-36`): Blob when it has credentials or `VERCEL=1`, otherwise fs. Memory runs only when `BOT_STORE=memory` is set.

## Invariants M1–M3 need

| # | Invariant | Shape that fits single-document CAS |
|---|---|---|
| I1 | Fenced run writes: a run that lost its lease cannot write | Fence counter and lease holder live in the job/run doc; every mutation is `updateDoc` that returns `null` unless `current.fence === myFence` |
| I2 | Single claim | `updateDoc` on the job doc, which already works this way (`jobs.ts:273`) |
| I3 | Approval/action single transition (`proposed → approved/rejected`, `approved → executing`) | One doc per `actionId`; each transition is `updateDoc` guarded on the source state |
| I4 | Atomic budget reservation under concurrent runs | **One budget doc per workspace** (per period) holding `limit`, `reserved`, and a map of `runId → amount`; check and reserve in one mutate. Settlement updates the same doc |
| I5 | Event inbox dedupe | Key = `inbox/<provider>/<installation>/<eventId>`, written with `expectedVersion: null` (create-if-absent) |
| I6 | Action + run updated together | Not atomic. Use ordered writes with a harmless intermediate state plus idempotent reconciliation (the pattern `jobs.ts:94-97` already uses for index-then-job) |

## Guarantee matrix

| | memory (`memory.ts`) | fs (`fs.ts`) | Vercel Blob (`blob.ts`, @vercel/blob 2.8.0) |
|---|---|---|---|
| Single-doc CAS mechanism | Check and set run with no `await` between them (`memory.ts:20-26`); version = global counter | Per-key promise queue serialises check→write (`fs.ts:18-35, 57-72`); version = sha256 of content (`fs.ts:9,50`) | Server-side: `ifMatch` → `x-if-match` header; `allowOverwrite:false` → create-only (`blob.ts:52-55`; SDK `chunk-YYMLUMXS.js:904-930`). 412 → `KvConflictError` (`blob.ts:20-23,59`) |
| Scope of CAS safety | One process (data is process-local, `memory.ts:8`) | **One process only.** Two processes sharing a data dir can both pass the check and both rename: a lost update or a double create | Cross-instance, cross-region (enforced by the Blob service) |
| Version semantics | Monotonic; no ABA | **Content-addressed: ABA possible.** A doc that changes back to identical bytes accepts an old version (tested). Fences must be counters inside the doc | ETag (strong form; weak `W/` stripped, `blob.ts:31`) |
| Create-if-absent (I5) | Yes | Yes, in one process | Yes (`allowOverwrite:false`, mapped from "already exists", `blob.ts:22`) |
| Conditional delete | No | No | SDK supports `del(..., {ifMatch})` but `blob.ts:64` does not use it |
| Torn writes / crash | n/a (lost on exit) | Write-to-staging then `rename` (`fs.ts:68-70`), so readers never see a partial doc. No `fsync`, so a power loss can lose the latest write. Stray `*.tmp` files are skipped by `list` (`fs.ts:116`) but never cleaned up | Single PUT; no partial objects |
| Read freshness | Immediate | Immediate | `useCache:false` on reads (`blob.ts:42,76`). `list` freshness is not verified here: treat it as possibly stale and never use it for invariants |
| List | Exact, sorted | Directory walk, not a snapshot (`fs.ts:92-100`) | Paginated, not a snapshot (`blob.ts:80-89`) |
| Multi-doc atomicity | None | None | None. `listDocs` reads each key separately (`index.ts:69-73`) |
| Tested | `tests/store-concurrency.test.ts` | `tests/store-concurrency.test.ts`, `tests/store.test.ts` | **Untested**: no @vercel/blob mock exists. Covered only by the error-name check in `tests/store.test.ts` |

### Ambiguous commits on Blob (finding)

The Blob SDK retries network errors and 5xx responses up to `VERCEL_BLOB_RETRIES` (default 10) times (`chunk-YYMLUMXS.js:630,751-815`). Suppose a conditional PUT commits but its response is lost. The retry is then refused with 412 (or "already exists") against our *own* write, so `blob.ts` reports a conflict. `updateDoc` re-reads and calls `mutate` again on a value that already contains its change. That gives:

- a non-idempotent mutate (`n + 1`) can apply twice
- a claim/transition guarded on state (`owner === null`) returns `null` ("someone else won") even though this caller won. The work stays leased until the lease expires
- create-if-absent reports a duplicate for a first delivery

So on Blob every mutate must be **idempotent and self-recognising**. It carries the writer's identity (`runId`, `fence`, `actionId`, `eventId`) and treats "already contains my change" as success, not as a lost race. The fs and memory backends do not retry, so this affects only Blob.

## Supported envelopes

- **Personal, single process on fs** (`npm run dev`/`start`, one `next dev` per project): I1–I5 hold. Running two server processes (or `eve dev` plus a separate worker) on one `BOT_DATA_DIR` is **unsupported**, because CAS silently degrades to last-writer-wins.
- **Vercel hosted on Blob** (any number of function instances): I1–I5 hold, provided the record shapes above are used and mutates are idempotent (see above). I6 is eventual consistency through ordered writes and reconciliation.
- **Memory**: tests only.

## Not guaranteed

Multi-document transactions; atomic `list` + read; cross-process fs coordination; conditional delete (deleting an inbox key re-opens it to duplicates, so never delete inbox keys inside the dedupe window); exactly-once updates on Blob without idempotent mutates; ordering of unrelated keys.

## Decision

Keep the single-document CAS model for M1. Design every M1 invariant as **one CAS on one document**:

1. Run fence and lease live in the job/run document. Every run-scoped write (`finish`, state, artifacts) is an `updateDoc` that checks `fence`. No unconditional `writeDoc` on shared records (the current unconditional writes, e.g. `connectors.ts:186` and `recipes.ts:103`, are config edits, not M1 state).
2. Action ledger: one doc per `actionId`, created with `expectedVersion: null`, with guarded state transitions. The provider receipt is stored in the same doc.
3. Budget: one reservation doc per workspace (and period). Admission, reservation and settlement are all mutations of that doc. Per-run documents must not be summed to check the limit.
4. Event inbox: key derived from the provider event ID, written create-if-absent. Store linked runs and replay attempts on the same doc.
5. Cross-record updates (action + run, job + index, delivery + outbox) use ordered writes. Write the intent or marker first, so a crash leaves a state that reconciliation can detect and finish.
6. Each mutate records who it is and returns success when it sees its own change already applied (Blob ambiguous commits).

Hot single-document contention (budget doc) is bounded: `updateDoc` serialises same-process callers and retries 5 times across instances, then throws. Callers must treat that throw as "admission failed, retry later", never as success.

## Triggers to adopt a transactional adapter

Add a transactional state adapter (Postgres or similar behind the same `Kv`/`updateDoc` surface plus a `transaction()` helper) when any of these holds:

- An invariant cannot be expressed as one document (for example, a budget shared across workspaces or projects, or atomic action + run + outbox commit required for correctness rather than reconciliation).
- Team mode needs multiple worker processes against one self-hosted store, or a self-hosted multi-instance deployment without Blob.
- Budget-doc or inbox contention causes `updateDoc` to exhaust its retries in normal load (measure conflict/retry counts first).
- Queries need indexes or consistent listings (board, audit, retention) beyond prefix `list`.
