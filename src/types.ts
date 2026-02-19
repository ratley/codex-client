export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: number;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface Thread {
  id: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TurnError {
  message: string;
  codexErrorInfo?: string;
}

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface FileChange {
  path: string;
  kind: string;
  diff: string;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status: string;
      exitCode?: number;
      aggregatedOutput?: string;
    }
  | { type: "fileChange"; id: string; changes: FileChange[]; status: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "reasoning"; id: string; summary?: unknown; content?: unknown }
  | { type: "plan"; id: string; text: string }
  | { type: string; id: string; [key: string]: unknown };

export interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  error?: TurnError;
  threadId?: string;
}

export interface PlanEntry {
  status?: string;
  step?: string;
  [key: string]: unknown;
}

export interface SandboxPolicy {
  type: string;
  writableRoots?: string[];
  networkAccess?: boolean;
}

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch" }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom" };

export interface StartThreadParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
}

export interface ResumeThreadParams {
  personality?: string;
}

export interface ListThreadsParams {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface StartTurnParams {
  threadId: string;
  input: TurnInput[];
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sandboxPolicy?: SandboxPolicy;
}

export interface SteerTurnParams {
  threadId: string;
  input: TurnInput[];
  expectedTurnId: string;
}

export interface StartReviewParams {
  threadId: string;
  delivery?: "inline" | "detached";
  target: ReviewTarget;
}

export interface ListModelsParams {
  cursor?: string;
  limit?: number;
}

export interface ExecCommandParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault?: boolean;
}

export interface ModelListResult {
  data: ModelInfo[];
  nextCursor?: string | null;
}

export interface ThreadListResult {
  data: Thread[];
  nextCursor?: string | null;
}

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReviewResult {
  turnId?: string;
  [key: string]: unknown;
}

export interface CompletedTurn {
  turn: Turn;
  items: ThreadItem[];
  agentMessage: string;
  diff?: string;
}

export interface CompletedReview {
  turn: Turn;
  reviewText: string;
}

export interface CodexClientOptions {
  clientName?: string;
  clientVersion?: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: "never" | "unlessTrusted" | "always";
  sandbox?: string;
  experimentalApi?: boolean;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  text: string;
}

export interface CommandOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  output: string;
}

export interface DiffUpdatedNotification {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface PlanUpdatedNotification {
  threadId?: string;
  turnId: string;
  plan: PlanEntry[];
}

export interface ThreadStartedNotification {
  thread: Thread;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  model: string;
  cwd: string;
  approvalPolicy: "never" | "unlessTrusted" | "always";
  sandbox: string;
  experimentalApi: boolean;
}
