# Codex App Server Client — Implementation Spec

## Overview

Build a TypeScript client library that wraps the `codex app-server` stdio protocol. The client spawns the app-server as a child process, communicates via JSON-RPC 2.0 over newline-delimited JSON (JSONL), and exposes a clean async API.

## Project Setup

- Runtime: Bun
- Entry point: `src/index.ts` (re-exports everything)
- Client implementation: `src/client.ts`
- Types: `src/types.ts`
- Tests: `src/__tests__/client.test.ts`

## Architecture

### Transport Layer (`src/transport.ts`)

Handles the raw JSON-RPC communication over stdio:

```ts
export class StdioTransport {
  constructor(private process: ChildProcess);
  
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  close(): Promise<void>;
}
```

- Spawns `codex app-server` with `stdio: ['pipe', 'pipe', 'inherit']`
- Reads stdout line-by-line, parses each line as JSON
- Writes to stdin as JSONL (JSON + newline)
- Tracks pending requests by `id` and resolves/rejects their promises when responses arrive
- Forwards notifications (no `id`) to registered notification handlers

### Client (`src/client.ts`)

High-level API wrapping the transport:

```ts
export class CodexClient extends EventEmitter {
  constructor(options?: CodexClientOptions);
  
  // Lifecycle
  async connect(): Promise<void>;  // spawns app-server, sends initialize + initialized
  async disconnect(): Promise<void>;  // closes transport
  
  // Threads
  async startThread(params: StartThreadParams): Promise<Thread>;
  async resumeThread(threadId: string, params?: ResumeThreadParams): Promise<Thread>;
  async forkThread(threadId: string): Promise<Thread>;
  async readThread(threadId: string, includeTurns?: boolean): Promise<Thread>;
  async listThreads(params?: ListThreadsParams): Promise<ThreadListResult>;
  async archiveThread(threadId: string): Promise<void>;
  async compactThread(threadId: string): Promise<void>;
  
  // Turns
  async startTurn(params: StartTurnParams): Promise<Turn>;
  async steerTurn(params: SteerTurnParams): Promise<string>;  // returns turnId
  async interruptTurn(threadId: string, turnId: string): Promise<void>;
  
  // Review
  async startReview(params: StartReviewParams): Promise<ReviewResult>;
  
  // Models
  async listModels(params?: ListModelsParams): Promise<ModelListResult>;
  
  // Command execution (sandboxed, no thread)
  async execCommand(params: ExecCommandParams): Promise<ExecCommandResult>;
}
```

### Options

```ts
interface CodexClientOptions {
  clientName?: string;       // default: "openclaw"
  clientVersion?: string;    // default: "0.1.0"
  model?: string;           // default: "gpt-5.3-codex"
  cwd?: string;             // default: process.cwd()
  approvalPolicy?: "never" | "unlessTrusted" | "always";  // default: "never"
  sandbox?: string;         // default: "workspaceWrite"
  experimentalApi?: boolean; // default: true
}
```

### Events (emitted by the client)

```ts
// Turn lifecycle
client.on("turn:started", (turn: Turn) => {});
client.on("turn:completed", (turn: Turn) => {});

// Item lifecycle
client.on("item:started", (item: ThreadItem) => {});
client.on("item:completed", (item: ThreadItem) => {});

// Streaming
client.on("item:agentMessage:delta", (delta: { itemId: string; text: string }) => {});
client.on("item:commandExecution:outputDelta", (delta: { itemId: string; output: string }) => {});

// Diff
client.on("turn:diff:updated", (data: { threadId: string; turnId: string; diff: string }) => {});

// Plan
client.on("turn:plan:updated", (data: { turnId: string; plan: PlanEntry[] }) => {});

// Thread
client.on("thread:started", (thread: Thread) => {});
```

### Turn Helper — `runTurn()`

A convenience method that starts a turn and waits for completion, collecting all items:

```ts
async runTurn(params: StartTurnParams): Promise<CompletedTurn> {
  // 1. Start the turn
  // 2. Collect all item:completed events for this turn
  // 3. Wait for turn:completed
  // 4. Return { turn, items, agentMessage, diff }
}
```

This is what we'll use most often — fire a task and get back the full result.

### Review Helper — `runReview()`

Similar convenience for reviews:

```ts
async runReview(params: StartReviewParams): Promise<CompletedReview> {
  // 1. Start the review
  // 2. Collect enteredReviewMode and exitedReviewMode items
  // 3. Wait for turn:completed
  // 4. Return { turn, reviewText }
}
```

## Types (`src/types.ts`)

Define all the types from the protocol spec. Key ones:

```ts
// JSON-RPC
interface JsonRpcRequest { method: string; id: number; params?: unknown; }
interface JsonRpcResponse { id: number; result?: unknown; error?: JsonRpcError; }
interface JsonRpcNotification { method: string; params?: unknown; }
interface JsonRpcError { code: number; message: string; }

// Thread
interface Thread { id: string; preview?: string; modelProvider?: string; createdAt?: number; updatedAt?: number; }

// Turn
interface Turn { id: string; status: "inProgress" | "completed" | "interrupted" | "failed"; items: ThreadItem[]; error?: TurnError; }
interface TurnError { message: string; codexErrorInfo?: string; }

// Items (simplified union)
type ThreadItem = 
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; cwd?: string; status: string; exitCode?: number; aggregatedOutput?: string }
  | { type: "fileChange"; id: string; changes: FileChange[]; status: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "reasoning"; id: string; summary?: unknown; content?: unknown }
  | { type: "plan"; id: string; text: string }
  | { type: string; id: string; [key: string]: unknown };  // catch-all

interface FileChange { path: string; kind: string; diff: string; }

// Params
interface StartThreadParams { model?: string; cwd?: string; approvalPolicy?: string; sandbox?: string; personality?: string; }
interface ResumeThreadParams { personality?: string; }
interface StartTurnParams { threadId: string; input: TurnInput[]; cwd?: string; model?: string; effort?: string; approvalPolicy?: string; sandboxPolicy?: SandboxPolicy; }
interface SteerTurnParams { threadId: string; input: TurnInput[]; expectedTurnId: string; }
interface StartReviewParams { threadId: string; delivery?: "inline" | "detached"; target: ReviewTarget; }

type TurnInput = { type: "text"; text: string } | { type: "image"; url: string } | { type: "localImage"; path: string } | { type: "skill"; name: string; path: string };
type ReviewTarget = { type: "uncommittedChanges" } | { type: "baseBranch" } | { type: "commit"; sha: string; title?: string } | { type: "custom" };

interface SandboxPolicy { type: string; writableRoots?: string[]; networkAccess?: boolean; }

// Results
interface CompletedTurn { turn: Turn; items: ThreadItem[]; agentMessage: string; diff?: string; }
interface CompletedReview { turn: Turn; reviewText: string; }
interface ModelListResult { data: ModelInfo[]; nextCursor?: string | null; }
interface ModelInfo { id: string; model: string; displayName: string; isDefault?: boolean; }
interface ThreadListResult { data: Thread[]; nextCursor?: string | null; }
interface ExecCommandResult { exitCode: number; stdout: string; stderr: string; }
```

## Request ID Management

Use an auto-incrementing counter starting at 0. The initialize handshake uses id=0.

## Error Handling

- If the app-server process exits unexpectedly, reject all pending requests and emit an `error` event
- If a request times out (default 5 minutes for turns, 30s for others), reject with a timeout error
- If a JSON-RPC error response comes back, reject the pending promise with the error message
- If `turn/completed` has `status: "failed"`, the `runTurn()` helper should reject with the error message

## Tests (`src/__tests__/client.test.ts`)

### Unit tests (mock the transport):

1. **initialize handshake** — connect() sends initialize + initialized, resolves on success
2. **startThread** — sends thread/start, returns Thread from response
3. **resumeThread** — sends thread/resume with threadId
4. **startTurn** — sends turn/start, returns Turn
5. **runTurn collects items** — mock a sequence: turn/started → item/started → item/agentMessage/delta → item/completed → turn/completed → verify CompletedTurn has everything
6. **steerTurn** — sends turn/steer with expectedTurnId
7. **interruptTurn** — sends turn/interrupt
8. **error response rejects** — JSON-RPC error response rejects the pending promise
9. **process exit rejects pending** — transport close rejects all pending requests

### Integration test (real app-server, guarded):

Only run if `codex` binary is available. Skip with a message if not.

1. **connect and list models** — spawn real app-server, connect, list models, disconnect
2. **start thread and run a simple turn** — start thread, run turn with "echo hello world", wait for completion, verify agent message exists

These integration tests should be in a separate file: `src/__tests__/integration.test.ts`

## File Structure

```
src/
  index.ts          — re-exports: CodexClient, types
  client.ts         — CodexClient class
  transport.ts      — StdioTransport (stdio JSON-RPC)
  types.ts          — all TypeScript types
  __tests__/
    client.test.ts       — unit tests with mocked transport
    integration.test.ts  — real app-server tests (guarded)
```

## Constraints

- TypeScript strict mode
- No `any` — use `unknown` and narrow
- ESM with `.js` imports (Bun convention — actually Bun resolves .ts, so no .js needed)
- No external dependencies beyond what Bun provides
- `bun test` must pass
- Export the client as both named and default export

## Commit

Single commit: `feat: codex app-server client with thread persistence, review, and streaming`
