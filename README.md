# Context Evictor (`opencode-context-evictor`)

**Semantic, rejection-triggered context eviction for OpenCode (`2.0.32` / V2 & `1.18.29+` / V1).**

`opencode-context-evictor` is an OpenCode plugin that enables an AI coding agent to immediately evict loaded context sources (`skill:<id>` or `file:<path>`) that it has inspected and determined to be irrelevant to the current task. Evicted sources are replaced with compact, deterministic tombstones on all subsequent model requests and compaction passes in the active session—without mutating or deleting persisted conversation history, breaking tool-call/result pairings, or unnecessarily invalidating prompt prefix caches.

---

## 1. Overview & Core Concept

During complex coding tasks, an agent frequently loads skills or reads files to inspect whether they apply to the problem at hand. For example, an agent investigating a slow query might load `skill:database-optimization`, inspect its contents, and realize the skill is written for PostgreSQL while the project uses MongoDB.

Without active eviction, that multi-kilobyte PostgreSQL skill remains in the conversation history for every remaining turn of the session, consuming context window budget, increasing token latency/cost, and distracting the model's attention.

### Semantic Rejection vs. Passive LRU / Heuristic Pruning

| Dimension | Passive LRU / Age-Based Pruning | **Context Evictor (Semantic Rejection)** |
| :--- | :--- | :--- |
| **Trigger** | Blindly drops old tool outputs after $N$ turns or token thresholds | Explicitly triggered by the agent (`context_evict`) only after inspecting a source and confirming irrelevance |
| **Safety** | Risks dropping foundational files or skills the agent still relies on | Never evicts uninspected, uncertain, or potentially useful context |
| **Timing** | Waits until context is already bloated or near limit | Evicts **immediately** on the very next model turn after inspection |
| **Reversibility** | Often destructive or requires re-reading from disk | Non-destructive copy-on-write filtering; instant restoration via `context_restore` or `/context-evictor restore` |

---

## 2. Architecture & OpenCode V2 / V1 Compatibility

`opencode-context-evictor` is built as a dual-mode plugin supporting both the **OpenCode V2 (`@opencode/plugin` >= 2.0.0)** host lifecycle (`setup(ctx)`) and the **OpenCode V1 (`@opencode-ai/plugin` >= 1.0.0)** server hook lifecycle (`server(input)`), plus a root `index.js` entrypoint for directory-form plugin loading.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       OpenCode Session Lifecycle                        │
│                                                                         │
│  1. Tool Execution (skill / read)                                       │
│     ├─ V2: ctx.tool.hook("execute.before" | "execute.after")            │
│     └─ V1: hooks["tool.execute.before" | "tool.execute.after"]          │
│            │                                                            │
│            ▼                                                            │
│  2. Provenance Tracker (src/tracker.ts)                                 │
│     ├─ Maps callID ──► canonical SourceID (skill:<id> | file:<path>)    │
│     └─ Structural scan across tool-call/result pairs & <skill_content>  │
│            │                                                            │
│            ▼                                                            │
│  3. Session Rejection Registry (src/registry.ts)                        │
│     ├─ Isolated per sessionID (in-memory Map + ctx.storage hydration)   │
│     └─ Mutated via context_evict / context_restore / /context-evictor   │
│            │                                                            │
│            ▼                                                            │
│  4. Copy-on-Write Context & Compaction Eviction (src/evictor.ts)        │
│     ├─ V2: ctx.session.hook("context") & ctx.session.hook("compaction") │
│     └─ V1: experimental.chat.messages.transform & session.compacting    │
│            ├─ 0 rejected sources ──► Fast-path No-Op (=== references)   │
│            └─ Has rejected sources ──► Clone mutated message spine only │
│               and replace payload with deterministic tombstone          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Core Components

- **Provenance Tracker (`src/tracker.ts`)**: Never relies on fragile substring searches across user or assistant prose. Instead, it combines proactive tool execution hooks (`execute.before` / `execute.after`) with structural transcript correlation across `tool-call` / `tool-result` pairs (`callID` / `toolCallId` / `tool_use_id`), dedicated `skill` parts/messages, and `<skill_content name="...">...</skill_content>` XML envelopes.
- **Session Registry (`src/registry.ts`)**: Maintains strictly isolated per-session state (`rejected`, `knownSources`, `callIdToSource`). When `ctx.storage` is provided by the host, minimal metadata (`context-evictor:session:<sessionID>`) is persisted so evictions survive session reloads without ever storing raw context content.
- **Copy-on-Write Eviction Engine (`src/evictor.ts`)**: Intercepts outgoing model context and compaction payloads, cloning only the specific message and part nodes that contain a rejected source while keeping all other messages reference-identical (`===`).

---

## 3. Installation

Build the TypeScript source first:

```bash
npm install
npm run build
```

### Option A: Project-Local Installation

1. **Via `opencode.json` in your project root:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./path/to/context-evictor"
  ],
  "context-evictor": {
    "enabled": true,
    "debug": false,
    "preserveMarkers": true
  }
}
```

2. **Via `.opencode/plugins/` directory:**
   Copy or symlink the plugin directory into `<project>/.opencode/plugins/context-evictor`. OpenCode V2 automatically discovers the root `index.js` and `package.json` entrypoints.

### Option B: Global Installation

1. **Via global OpenCode config (`~/.config/opencode/opencode.json`):**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-context-evictor"
  ]
}
```

2. **Via global plugins directory (`~/.config/opencode/plugins/`):**
   Place or symlink the built plugin folder at `~/.config/opencode/plugins/context-evictor`.

---

## 4. Configuration

Configuration is resolved with the following precedence (highest to lowest):
1. Runtime options passed directly to `createContextEvictorPlugin(options)` or `ctx.options["context-evictor"]`.
2. Project or global `opencode.json` / `opencode.jsonc` under `"context-evictor"` (or `"plugins": { "context-evictor": { ... } }`).
3. Dedicated `.opencode/context-evictor.json` file.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Enables or disables Context Evictor globally. When `false`, hooks become zero-overhead no-ops. |
| `debug` | `boolean` | `false` | Enables privacy-safe structured telemetry logging for rejections, evictions, restores, and resets. |
| `preserveMarkers` | `boolean` | `true` | When `true`, replaces evicted payloads with `[Context Evicted: <kind> <target> was inspected and rejected for this task.]`. When `false`, uses `[Context Evicted]`. |
| `logFile` | `string` *(optional)* | `undefined` | Optional file path to append structured JSONL debug entries when `debug: true`. |

---

## 5. Tools & Slash Commands

### Model-Callable Tools

#### `context_evict`
Marks an inspected context source as rejected for the current session so its payload is replaced with a tombstone on all subsequent model requests and compaction passes.

- **Arguments**:
  - `source_id` (`string`, required): Canonical identifier (`"skill:<id>"` or `"file:<path>"`).
  - `reason` (`string`, required): Concise explanation of why the inspected source is irrelevant to the current task.
- **Behavior**:
  - Validates `source_id` syntax and non-empty `reason`.
  - Verifies that `source_id` was actually loaded in the current session. If unknown/unloaded, fails safely without modifying context.
  - Idempotent on duplicate calls for the same `source_id` (preserves original `rejectedAt` timestamp and `reason`).

#### `context_restore`
Restores a previously evicted source in the current session so its full original content is included again on subsequent model requests.

- **Arguments**:
  - `source_id` (`string`, required): Canonical identifier (`"skill:<id>"` or `"file:<path>"`).

#### `context_evict_status` (alias: `context_status`)
Inspects or resets the current session's eviction state.

- **Arguments**:
  - `action` (`"status" | "reset"`, optional, default `"status"`): Pass `"status"` for a diagnostic summary or `"reset"` to clear all active evictions in the session.

#### `context_reset`
Clears all active evictions in the current session and restores all previously rejected sources.

### Interactive Slash Command

```text
/context-evictor [status | restore <source_id> | reset | evict <source_id> [reason]]
```

- `/context-evictor` or `/context-evictor status`: Displays active evicted sources, rejection reasons, pass counts, characters saved, and all known loaded sources in the session.
- `/context-evictor restore <source_id>`: Restores a specific source (e.g., `/context-evictor restore skill:database-optimization`).
- `/context-evictor reset`: Clears all evictions for the current session.
- `/context-evictor evict <source_id> [reason]`: Manually evicts a loaded source from the session.

---

## 6. Supported Source Identifiers

Only two canonical source identifier prefixes are supported:

1. **Skills (`skill:<id>`)**:
   - Format: `skill:<skill-name>` (non-empty identifier without whitespace or control characters).
   - Examples: `skill:database-optimization`, `skill:mongodb-indexing`, `skill:react-performance`.
2. **Files (`file:<path>`)**:
   - Format: `file:<workspace-relative-path>`.
   - Cross-platform path normalization automatically converts Windows backslashes (`\`) to forward slashes (`/`), strips leading `./`, and strips the workspace root prefix if an absolute path inside the workspace is supplied.
   - Examples: `file:src/config/database.ts`, `file:src/models/user.ts`.

---

## 7. Complete Walkthrough Example

### Step 1: Agent Loads a Skill and Inspects It
The user asks the agent to optimize a slow MongoDB aggregation pipeline. The agent calls the `skill` tool with `{ "id": "database-optimization" }`.

**Outgoing Request Context (Turn 1 — Before Eviction):**
```json
[
  {
    "id": "msg-1",
    "role": "user",
    "content": "Optimize our slow MongoDB order lookup query by tenantId and createdAt."
  },
  {
    "id": "msg-2",
    "role": "assistant",
    "parts": [
      {
        "type": "tool-call",
        "callID": "call-skill-pg",
        "toolName": "skill",
        "args": { "id": "database-optimization" }
      }
    ]
  },
  {
    "id": "msg-3",
    "role": "tool",
    "callID": "call-skill-pg",
    "parts": [
      {
        "type": "tool-result",
        "callID": "call-skill-pg",
        "toolName": "skill",
        "output": "# Skill: database-optimization (PostgreSQL 16+)\n\nAlways run EXPLAIN (ANALYZE, BUFFERS)... [3,500 chars of PostgreSQL instructions]"
      }
    ]
  }
]
```

### Step 2: Agent Determines Irrelevance and Calls `context_evict`
Upon inspecting `msg-3`, the agent sees that `skill:database-optimization` is strictly for PostgreSQL, whereas the service uses MongoDB. The agent invokes:

```json
{
  "tool": "context_evict",
  "args": {
    "source_id": "skill:database-optimization",
    "reason": "The skill targets PostgreSQL, but this task uses MongoDB."
  }
}
```

### Step 3: Subsequent Model Request (`context` Hook Redaction)
On Turn 2 (and all subsequent turns in the session), the `context` hook intercepts the outgoing request and replaces the rejected payload in `msg-3` with a deterministic tombstone while keeping `callID`, role, and message ordering intact:

**Outgoing Request Context (Turn 2+ — After Eviction):**
```json
[
  {
    "id": "msg-1",
    "role": "user",
    "content": "Optimize our slow MongoDB order lookup query by tenantId and createdAt."
  },
  {
    "id": "msg-2",
    "role": "assistant",
    "parts": [
      {
        "type": "tool-call",
        "callID": "call-skill-pg",
        "toolName": "skill",
        "args": { "id": "database-optimization" }
      }
    ]
  },
  {
    "id": "msg-3",
    "role": "tool",
    "callID": "call-skill-pg",
    "parts": [
      {
        "type": "tool-result",
        "callID": "call-skill-pg",
        "toolName": "skill",
        "output": "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
      }
    ]
  }
]
```

Meanwhile, the persisted transcript in OpenCode's database still holds the original 3,500-character PostgreSQL skill text untouched. If the user later asks a PostgreSQL question in the same session, calling `context_restore({ source_id: "skill:database-optimization" })` immediately restores the full text on the next turn.

---

## 8. Prefix-Cache Preservation Guarantees & Honest Limitations

LLM providers (Anthropic Prompt Caching, OpenAI Prompt Caching, Gemini Context Caching, vLLM prefix caching) cache KV states over exact token prefixes from the beginning of a request (`system` prompt + `messages[0..n]`). `opencode-context-evictor` is engineered to maximize prefix-cache hit rates:

### What Is Guaranteed

1. **Turn-1 System Prompt Stability**:
   The behavioral instruction (`SYSTEM_INSTRUCTION`) is appended to `event.system` deterministically starting on **Turn 1**—before any rejection occurs—and deduplicated on all subsequent turns. Consequently, when the first eviction happens on Turn $m$, `event.system` does **not** change, preventing a root-level cache invalidation of the entire conversation.
2. **Zero-Clone Fast Path**:
   When a session has `0` active rejected sources, `evictRejectedFromMessages` returns the input `messages` array with exact JavaScript reference identity (`result.messages === event.messages`) and zero allocations.
3. **Strict Prefix Reference & Byte Identity (`0 .. k-1`)**:
   When the earliest evicted source in a transcript resides at message index $k$, all earlier messages `0 .. k-1` (and all unaffected later messages `k+1 .. n`) retain strict object reference identity (`===`) and byte-for-byte serialization identity.
4. **Static, Deterministic Tombstones**:
   Tombstones (`[Context Evicted: <kind> <target> was inspected and rejected for this task.]`) depend **only** on `kind`, normalized `target`, and `preserveMarkers`. They never embed timestamps, random IDs, or mutable user-provided `reason` strings.

### Honest Physical Limitation of LLM KV Caches

By the physical definition of autoregressive transformer KV caches, **modifying tokens at message index $k$ invalidates the provider's cached KV states for tokens at index $\ge k$ on the single turn where the eviction first takes effect**:
- **On the turn immediately following `context_evict` of a message at index $k$**: The provider reuses 100% of the cached KV prefix for `system` + `messages[0 .. k-1]`, and recomputes KV states from index $k$ onward (which is now shorter because the large payload at $k$ was replaced by a 1-line tombstone).
- **On all subsequent turns ($k+1, k+2, \dots$)**: Because the tombstone at index $k$ is 100% static and deterministic, the new prefix through index $k$ and beyond is immediately re-cached and reused on every future turn in the session.

---

## 9. Large-Scale Benchmark & Empirical Usage Metrics

To evaluate real-world performance under heavy production context load, `opencode-context-evictor` includes a comprehensive stress test and benchmark suite (`tests/large-scale.benchmark.ts` and `tests/large-scale.test.ts`).

### Benchmark Scenario
- **Workload**: An extended **100-turn** architectural and implementation session simulating a checkout platform refactor.
- **Initial Context Load**: **15 heavy sources** (5 comprehensive skills and 10 real-world codebase files totaling **63,882 characters / ~15,971 tokens**).
- **Selective Eviction**: The agent inspects loaded sources and calls `context_evict` on **8 irrelevant sources** (3 unneeded database/infra skills: PostgreSQL, Kubernetes, DynamoDB; and 5 legacy components: Oracle DB adapter, SOAP client, streaming XML parser, sticky session manager, and 3DES crypto).
- **Preserved Context**: **7 relevant sources** (GraphQL Federation subgraph, MongoDB aggregation skill, Order/Customer domain models, Stripe payment service, distributed inventory service, REST API controller) are retained 100% byte-identical.

### Empirical Results

| Metric | Measured Value | Benchmark Threshold / Target | Status |
| :--- | :--- | :--- | :--- |
| **Conversational Turns Tested** | **100 turns** | $\ge 50$ turns | Pass |
| **Sources Loaded / Evicted** | **15 loaded / 8 evicted / 7 retained** | 5 skills + 10 files | Pass |
| **Un-evicted Context Size** | **63,882 chars** (~**15,971 tokens**) | $> 50,000$ chars / $> 12,500$ tokens | Pass |
| **Evicted Context Size** | **31,357 chars** (~**7,840 tokens**) | Compact tombstone replacements | Pass |
| **Net Context Window Savings** | **32,525 chars saved** (~**8,131 tokens**, **50.91% reduction**) | $> 40\%$ context reduction | Pass |
| **Prefix-Cache Preservation** | **100% prefix retention** (`0..k-1` strict `===` object identity) | Strict JS reference & byte determinism | Pass |
| **Average Hook Latency** | **0.34 ms / turn** | $< 5.0\text{ ms}$ | Pass (14x faster than SLA) |
| **P95 Hook Latency** | **0.72 ms / turn** | $< 5.0\text{ ms}$ | Pass (7x faster than SLA) |
| **Total 100-Turn Hook Exec Time**| **33.98 ms** (across all 100 turns combined) | $< 500\text{ ms}$ | Pass |

```
Context Window Reduction: 63,882 chars ───────► 31,357 chars (-50.91%)
                       [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓] Before Eviction (~15,971 tokens)
                       [▓▓▓▓▓▓▓▓▓▓          ] After Eviction  (~7,840 tokens)
```

---

## 10. Privacy-Safe Debug Logging & Testing

### Privacy-Safe Telemetry (`debug: true`)

When `debug: true` is enabled in configuration, `PrivacySafeLogger` emits structured JSON telemetry events (`rejection_recorded`, `context_evicted`, `source_restored`, `session_reset`) containing:
- `timestamp`, `sessionID`, `sourceId`, `reason`
- `evictionSucceeded`, `charsRemoved`, `alreadyRejected`, `identificationFailed`, `activeRejectedCount`

**Privacy Guarantee**: The logger **never** logs raw skill instructions, file contents, or message text—even when `debug: true` or `logFile` is configured.

### Running Verification & Tests

```bash
# Type-check without emitting files
npm run typecheck

# Compile TypeScript and run the complete test suite (Specification Tests A–K + Large-Scale Benchmark)
npm test

# Run standalone large-scale benchmark runner
npm run benchmark
```
