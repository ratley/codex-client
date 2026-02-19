import { EventEmitter } from "node:events";
import { StdioTransport, isJsonRpcNotification } from "./transport";
import type {
  AgentMessageDeltaNotification,
  CodexClientOptions,
  CommandOutputDeltaNotification,
  CompletedReview,
  CompletedTurn,
  DiffUpdatedNotification,
  ExecCommandParams,
  ExecCommandResult,
  InitializeParams,
  ItemNotification,
  JsonRpcMessage,
  ListModelsParams,
  ListThreadsParams,
  ModelListResult,
  PlanEntry,
  PlanUpdatedNotification,
  ReviewResult,
  ResumeThreadParams,
  StartReviewParams,
  StartThreadParams,
  StartTurnParams,
  SteerTurnParams,
  Thread,
  ThreadItem,
  ThreadListResult,
  ThreadStartedNotification,
  Turn,
  TurnCompletedNotification,
  TurnStartedNotification,
} from "./types";

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

interface TransportLike {
  send(message: JsonRpcMessage): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onMessage(handler: (message: JsonRpcMessage) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  close(): Promise<void>;
}

interface CodexClientInternalOptions extends CodexClientOptions {
  transportFactory?: (cwd: string) => TransportLike;
}

const DEFAULT_OPTIONS: Required<CodexClientOptions> = {
  clientName: "openclaw",
  clientVersion: "0.1.0",
  model: "gpt-5.3-codex",
  cwd: process.cwd(),
  approvalPolicy: "never",
  sandbox: "workspaceWrite",
  experimentalApi: true,
};

export class CodexClient extends EventEmitter {
  private transport: TransportLike | null = null;
  private readonly options: Required<CodexClientOptions>;
  private readonly transportFactory: (cwd: string) => TransportLike;
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private readonly completedTurns = new Map<string, Turn>();

  constructor(options: CodexClientInternalOptions = {}) {
    super();

    this.options = {
      clientName: options.clientName ?? DEFAULT_OPTIONS.clientName,
      clientVersion: options.clientVersion ?? DEFAULT_OPTIONS.clientVersion,
      model: options.model ?? DEFAULT_OPTIONS.model,
      cwd: options.cwd ?? DEFAULT_OPTIONS.cwd,
      approvalPolicy: options.approvalPolicy ?? DEFAULT_OPTIONS.approvalPolicy,
      sandbox: options.sandbox ?? DEFAULT_OPTIONS.sandbox,
      experimentalApi: options.experimentalApi ?? DEFAULT_OPTIONS.experimentalApi,
    };

    this.transportFactory =
      options.transportFactory ??
      ((cwd: string) => {
        return StdioTransport.spawn(cwd);
      });
  }

  async connect(): Promise<void> {
    if (this.transport) {
      return;
    }

    this.transport = this.transportFactory(this.options.cwd);

    this.unsubscribeMessage = this.transport.onMessage((message) => {
      this.handleMessage(message);
    });

    this.unsubscribeError = this.transport.onError((error) => {
      this.emit("error", error);
    });

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: this.options.clientName,
        version: this.options.clientVersion,
      },
      model: this.options.model,
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      experimentalApi: this.options.experimentalApi,
    };

    await this.transport.request("initialize", initializeParams, DEFAULT_TIMEOUT_MS);
    this.transport.send({ jsonrpc: "2.0", method: "initialized" });
  }

  async disconnect(): Promise<void> {
    if (!this.transport) {
      return;
    }

    const current = this.transport;
    this.transport = null;

    if (this.unsubscribeMessage) {
      this.unsubscribeMessage();
      this.unsubscribeMessage = null;
    }

    if (this.unsubscribeError) {
      this.unsubscribeError();
      this.unsubscribeError = null;
    }

    await current.close();
  }

  async startThread(params: StartThreadParams): Promise<Thread> {
    const payload = {
      model: params.model ?? this.options.model,
      cwd: params.cwd ?? this.options.cwd,
      approvalPolicy: params.approvalPolicy ?? this.options.approvalPolicy,
      sandbox: params.sandbox ?? this.options.sandbox,
      ...(params.personality ? { personality: params.personality } : {}),
    };

    const result = await this.request("thread/start", payload);
    return extractThread(result);
  }

  async resumeThread(
    threadId: string,
    params: ResumeThreadParams = {},
  ): Promise<Thread> {
    const result = await this.request("thread/resume", {
      threadId,
      ...params,
    });

    return extractThread(result);
  }

  async forkThread(threadId: string): Promise<Thread> {
    const result = await this.request("thread/fork", { threadId });
    return extractThread(result);
  }

  async readThread(threadId: string, includeTurns?: boolean): Promise<Thread> {
    const result = await this.request("thread/read", {
      threadId,
      ...(includeTurns !== undefined ? { includeTurns } : {}),
    });

    return extractThread(result);
  }

  async listThreads(params: ListThreadsParams = {}): Promise<ThreadListResult> {
    const result = await this.request("thread/list", params);
    return extractThreadList(result);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request("thread/compact", { threadId });
  }

  async startTurn(params: StartTurnParams): Promise<Turn> {
    const result = await this.request("turn/start", params, TURN_TIMEOUT_MS);
    return extractTurn(result);
  }

  async steerTurn(params: SteerTurnParams): Promise<string> {
    const result = await this.request("turn/steer", params, TURN_TIMEOUT_MS);

    if (isObject(result) && typeof result.turnId === "string") {
      return result.turnId;
    }

    if (isObject(result) && isObject(result.turn) && typeof result.turn.id === "string") {
      return result.turn.id;
    }

    throw new Error("Missing turnId in turn/steer result");
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, DEFAULT_TIMEOUT_MS);
  }

  async startReview(params: StartReviewParams): Promise<ReviewResult> {
    const result = await this.request("review/start", params, TURN_TIMEOUT_MS);

    if (isObject(result)) {
      return result;
    }

    return {};
  }

  async listModels(params: ListModelsParams = {}): Promise<ModelListResult> {
    const result = await this.request("model/list", params);
    return extractModelList(result);
  }

  async execCommand(params: ExecCommandParams): Promise<ExecCommandResult> {
    const result = await this.request("command/exec", params, TURN_TIMEOUT_MS);
    return extractExecCommandResult(result);
  }

  async runTurn(params: StartTurnParams): Promise<CompletedTurn> {
    const itemsByTurn = new Map<string, ThreadItem[]>();
    const diffByTurn = new Map<string, string>();
    const agentMessagesByTurn = new Map<string, Map<string, string>>();

    const onItemCompleted = (payload: ItemNotification): void => {
      const items = itemsByTurn.get(payload.turnId) ?? [];
      items.push(payload.item);
      itemsByTurn.set(payload.turnId, items);

      if (payload.item.type === "agentMessage") {
        const byItem = agentMessagesByTurn.get(payload.turnId) ?? new Map<string, string>();
        const current = byItem.get(payload.item.id) ?? "";
        const text = typeof payload.item.text === "string" ? payload.item.text : "";
        byItem.set(payload.item.id, `${current}${text}`);
        agentMessagesByTurn.set(payload.turnId, byItem);
      }
    };

    const onAgentDelta = (payload: AgentMessageDeltaNotification): void => {
      const byItem = agentMessagesByTurn.get(payload.turnId) ?? new Map<string, string>();
      const current = byItem.get(payload.itemId) ?? "";
      byItem.set(payload.itemId, `${current}${payload.text}`);
      agentMessagesByTurn.set(payload.turnId, byItem);
    };

    const onDiff = (payload: DiffUpdatedNotification): void => {
      diffByTurn.set(payload.turnId, payload.diff);
    };

    this.on("_internal:itemCompleted", onItemCompleted);
    this.on("_internal:agentDelta", onAgentDelta);
    this.on("_internal:turnDiff", onDiff);

    try {
      const turn = await this.startTurn(params);
      const completedTurn = await this.waitForTurnCompletion(turn.id, TURN_TIMEOUT_MS);

      if (completedTurn.status === "failed") {
        const message = completedTurn.error?.message ?? "Turn failed";
        throw new Error(message);
      }

      const items = itemsByTurn.get(turn.id) ?? [];
      const agentMessage = this.extractAgentMessage(
        items,
        agentMessagesByTurn.get(turn.id) ?? new Map<string, string>(),
      );

      return {
        turn: completedTurn,
        items,
        agentMessage,
        diff: diffByTurn.get(turn.id),
      };
    } finally {
      this.off("_internal:itemCompleted", onItemCompleted);
      this.off("_internal:agentDelta", onAgentDelta);
      this.off("_internal:turnDiff", onDiff);
    }
  }

  async runReview(params: StartReviewParams): Promise<CompletedReview> {
    const result = await this.startReview(params);
    const reviewTurnId = typeof result.turnId === "string" ? result.turnId : undefined;

    const reviewTexts: string[] = [];
    const onItemCompleted = (payload: ItemNotification): void => {
      if (reviewTurnId && payload.turnId !== reviewTurnId) {
        return;
      }

      if (
        payload.item.type === "enteredReviewMode" ||
        payload.item.type === "exitedReviewMode"
      ) {
        const review = payload.item.review;
        if (typeof review === "string" && review.length > 0) {
          reviewTexts.push(review);
        }
      }
    };

    this.on("_internal:itemCompleted", onItemCompleted);

    try {
      const turn = reviewTurnId
        ? await this.waitForTurnCompletion(reviewTurnId, TURN_TIMEOUT_MS)
        : await this.waitForAnyThreadTurnCompletion(params.threadId, TURN_TIMEOUT_MS);

      return {
        turn,
        reviewText: reviewTexts.join("\n").trim(),
      };
    } finally {
      this.off("_internal:itemCompleted", onItemCompleted);
    }
  }

  private async request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const transport = this.ensureConnected();
    return transport.request(method, params, timeoutMs);
  }

  private ensureConnected(): TransportLike {
    if (!this.transport) {
      throw new Error("Client is not connected. Call connect() first.");
    }

    return this.transport;
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!isJsonRpcNotification(message)) {
      return;
    }

    const { method, params } = message;

    switch (method) {
      case "turn/started": {
        const data = asTurnNotification(params);
        if (!data) return;
        this.emit("turn:started", data.turn);
        break;
      }
      case "turn/completed": {
        const data = asTurnCompletedNotification(params);
        if (!data) return;
        this.completedTurns.set(data.turn.id, data.turn);
        this.emit("turn:completed", data.turn);
        this.emit("_internal:turnCompleted", data);
        break;
      }
      case "item/started": {
        const data = asItemNotification(params);
        if (!data) return;
        this.emit("item:started", data.item);
        break;
      }
      case "item/completed": {
        const data = asItemNotification(params);
        if (!data) return;
        this.emit("item:completed", data.item);
        this.emit("_internal:itemCompleted", data);
        break;
      }
      case "item/agentMessage/delta": {
        const data = asAgentDeltaNotification(params);
        if (!data) return;
        this.emit("item:agentMessage:delta", {
          itemId: data.itemId,
          text: data.text,
        });
        this.emit("_internal:agentDelta", data);
        break;
      }
      case "item/commandExecution/outputDelta": {
        const data = asCommandOutputDeltaNotification(params);
        if (!data) return;
        this.emit("item:commandExecution:outputDelta", {
          itemId: data.itemId,
          output: data.output,
        });
        break;
      }
      case "turn/diff/updated": {
        const data = asDiffUpdatedNotification(params);
        if (!data) return;
        this.emit("turn:diff:updated", {
          threadId: data.threadId,
          turnId: data.turnId,
          diff: data.diff,
        });
        this.emit("_internal:turnDiff", data);
        break;
      }
      case "turn/plan/updated": {
        const data = asPlanUpdatedNotification(params);
        if (!data) return;
        this.emit("turn:plan:updated", {
          turnId: data.turnId,
          plan: data.plan,
        });
        break;
      }
      case "thread/started": {
        const data = asThreadStartedNotification(params);
        if (!data) return;
        this.emit("thread:started", data.thread);
        break;
      }
      default:
        break;
    }
  }

  private waitForTurnCompletion(turnId: string, timeoutMs: number): Promise<Turn> {
    const alreadyCompleted = this.completedTurns.get(turnId);
    if (alreadyCompleted) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(alreadyCompleted);
    }

    return new Promise<Turn>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("_internal:turnCompleted", onTurnCompleted);
        reject(new Error(`Timed out waiting for turn completion: ${turnId}`));
      }, timeoutMs);

      const onTurnCompleted = (notification: TurnCompletedNotification): void => {
        if (notification.turn.id !== turnId) {
          return;
        }

        clearTimeout(timeout);
        this.off("_internal:turnCompleted", onTurnCompleted);
        this.completedTurns.delete(turnId);
        resolve(notification.turn);
      };

      this.on("_internal:turnCompleted", onTurnCompleted);
    });
  }

  private waitForAnyThreadTurnCompletion(
    threadId: string,
    timeoutMs: number,
  ): Promise<Turn> {
    return new Promise<Turn>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("_internal:turnCompleted", onTurnCompleted);
        reject(
          new Error(`Timed out waiting for turn completion on thread ${threadId}`),
        );
      }, timeoutMs);

      const onTurnCompleted = (notification: TurnCompletedNotification): void => {
        if (notification.threadId !== threadId) {
          return;
        }

        clearTimeout(timeout);
        this.off("_internal:turnCompleted", onTurnCompleted);
        resolve(notification.turn);
      };

      this.on("_internal:turnCompleted", onTurnCompleted);
    });
  }

  private extractAgentMessage(
    items: ThreadItem[],
    deltas: Map<string, string>,
  ): string {
    for (const item of items) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.length) {
        return item.text;
      }
    }

    if (deltas.size > 0) {
      const chunks: string[] = [];
      for (const value of deltas.values()) {
        chunks.push(value);
      }
      return chunks.join("");
    }

    return "";
  }
}

function extractThread(result: unknown): Thread {
  if (isObject(result) && isThread(result)) {
    return result;
  }

  if (isObject(result) && isThread(result.thread)) {
    return result.thread;
  }

  throw new Error("Invalid thread response");
}

function extractTurn(result: unknown): Turn {
  if (isObject(result) && isTurn(result)) {
    return result;
  }

  if (isObject(result) && isTurn(result.turn)) {
    return result.turn;
  }

  throw new Error("Invalid turn response");
}

function extractThreadList(result: unknown): ThreadListResult {
  if (isObject(result) && Array.isArray(result.data)) {
    return {
      data: result.data.filter(isThread),
      nextCursor:
        typeof result.nextCursor === "string" || result.nextCursor === null
          ? result.nextCursor
          : undefined,
    };
  }

  throw new Error("Invalid thread list response");
}

function extractModelList(result: unknown): ModelListResult {
  if (isObject(result) && Array.isArray(result.data)) {
    const data = result.data.filter((model): model is ModelListResult["data"][number] => {
      return (
        isObject(model) &&
        typeof model.id === "string" &&
        typeof model.model === "string" &&
        typeof model.displayName === "string"
      );
    });

    return {
      data,
      nextCursor:
        typeof result.nextCursor === "string" || result.nextCursor === null
          ? result.nextCursor
          : undefined,
    };
  }

  throw new Error("Invalid model list response");
}

function extractExecCommandResult(result: unknown): ExecCommandResult {
  if (
    isObject(result) &&
    typeof result.exitCode === "number" &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string"
  ) {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  throw new Error("Invalid command execution response");
}

function asTurnNotification(params: unknown): TurnStartedNotification | null {
  if (isObject(params) && typeof params.threadId === "string" && isTurn(params.turn)) {
    return { threadId: params.threadId, turn: params.turn };
  }

  return null;
}

function asTurnCompletedNotification(
  params: unknown,
): TurnCompletedNotification | null {
  if (isObject(params) && typeof params.threadId === "string" && isTurn(params.turn)) {
    return { threadId: params.threadId, turn: params.turn };
  }

  return null;
}

function asItemNotification(params: unknown): ItemNotification | null {
  if (
    isObject(params) &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    isThreadItem(params.item)
  ) {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      item: params.item,
    };
  }

  return null;
}

function asAgentDeltaNotification(
  params: unknown,
): AgentMessageDeltaNotification | null {
  if (
    isObject(params) &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    typeof params.itemId === "string" &&
    typeof params.text === "string"
  ) {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      text: params.text,
    };
  }

  return null;
}

function asCommandOutputDeltaNotification(
  params: unknown,
): CommandOutputDeltaNotification | null {
  if (
    isObject(params) &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    typeof params.itemId === "string" &&
    typeof params.output === "string"
  ) {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      output: params.output,
    };
  }

  return null;
}

function asDiffUpdatedNotification(params: unknown): DiffUpdatedNotification | null {
  if (
    isObject(params) &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    typeof params.diff === "string"
  ) {
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      diff: params.diff,
    };
  }

  return null;
}

function asPlanUpdatedNotification(params: unknown): PlanUpdatedNotification | null {
  if (
    isObject(params) &&
    typeof params.turnId === "string" &&
    Array.isArray(params.plan)
  ) {
    return {
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      turnId: params.turnId,
      plan: params.plan as PlanEntry[],
    };
  }

  return null;
}

function asThreadStartedNotification(
  params: unknown,
): ThreadStartedNotification | null {
  if (isObject(params) && isThread(params.thread)) {
    return { thread: params.thread };
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThread(value: unknown): value is Thread {
  return isObject(value) && typeof value.id === "string";
}

function isTurn(value: unknown): value is Turn {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.items)
  );
}

function isThreadItem(value: unknown): value is ThreadItem {
  return isObject(value) && typeof value.id === "string" && typeof value.type === "string";
}
