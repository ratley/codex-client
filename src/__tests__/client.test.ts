import { describe, expect, test } from "bun:test";
import { CodexClient } from "../client";
import { StdioTransport, type StdioProcess } from "../transport";
import type { JsonRpcMessage, JsonRpcNotification, Thread, ThreadItem, Turn } from "../types";

class MockTransport {
  public readonly sent: JsonRpcMessage[] = [];
  public readonly requests: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];
  public closed = false;

  private readonly messageHandlers = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly responders = new Map<string, (params?: unknown) => unknown>();

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params, timeoutMs });
    const responder = this.responders.get(method);

    if (!responder) {
      return {};
    }

    return responder(params);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  setResponder(method: string, responder: (params?: unknown) => unknown): void {
    this.responders.set(method, responder);
  }

  emitNotification(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

describe("CodexClient unit", () => {
  test("initialize handshake", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({ capabilities: {} }));

    const client = new CodexClient({
      transportFactory: () => transport,
    });

    await client.connect();

    expect(transport.requests[0]?.method).toBe("initialize");
    expect(transport.sent).toContainEqual({ jsonrpc: "2.0", method: "initialized" });
  });

  test("startThread", async () => {
    const transport = new MockTransport();
    const expected: Thread = { id: "thread-1" };

    transport.setResponder("initialize", () => ({}));
    transport.setResponder("thread/start", () => ({ thread: expected }));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    const result = await client.startThread({});
    expect(result).toEqual(expected);
    expect(transport.requests[1]?.method).toBe("thread/start");
  });

  test("resumeThread", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({}));
    transport.setResponder("thread/resume", () => ({ thread: { id: "thread-2" } }));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    const result = await client.resumeThread("thread-2");
    expect(result.id).toBe("thread-2");
    expect(transport.requests[1]?.params).toEqual({ threadId: "thread-2" });
  });

  test("startTurn", async () => {
    const transport = new MockTransport();
    const turn: Turn = { id: "turn-1", status: "inProgress", items: [] };

    transport.setResponder("initialize", () => ({}));
    transport.setResponder("turn/start", () => ({ turn }));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    const result = await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual(turn);
  });

  test("runTurn collects items", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({}));
    transport.setResponder("turn/start", () => ({ turn: { id: "turn-1", status: "inProgress", items: [] } }));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    const promise = client.runTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "echo hello world" }],
    });

    const item: ThreadItem = {
      type: "agentMessage",
      id: "item-1",
      text: "hello world",
    };

    transport.emitNotification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    transport.emitNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item,
    });
    transport.emitNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "hello world",
    });
    transport.emitNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item,
    });
    transport.emitNotification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [item] },
    });

    const completed = await promise;

    expect(completed.turn.id).toBe("turn-1");
    expect(completed.items).toHaveLength(1);
    expect(completed.agentMessage).toBe("hello world");
  });

  test("steerTurn", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({}));
    transport.setResponder("turn/steer", () => ({ turnId: "turn-2" }));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    const turnId = await client.steerTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "continue" }],
      expectedTurnId: "turn-1",
    });

    expect(turnId).toBe("turn-2");
  });

  test("interruptTurn", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({}));
    transport.setResponder("turn/interrupt", () => ({}));

    const client = new CodexClient({ transportFactory: () => transport });
    await client.connect();

    await client.interruptTurn("thread-1", "turn-1");

    expect(transport.requests[1]?.method).toBe("turn/interrupt");
    expect(transport.requests[1]?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  test("error response rejects", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => {
      throw new Error("-32603: boom");
    });

    const client = new CodexClient({ transportFactory: () => transport });

    await expect(client.connect()).rejects.toThrow("boom");
  });
});

describe("StdioTransport", () => {
  test("process exit rejects pending", async () => {
    let resolveExit: ((value: number) => void) | undefined;

    const stdout = new ReadableStream<Uint8Array>({
      start() {
        // keep open for this test
      },
    });

    const process: StdioProcess = {
      stdin: {
        write() {
          return undefined;
        },
        end() {
          return undefined;
        },
      },
      stdout,
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill() {
        return undefined;
      },
    };

    const transport = new StdioTransport(process);

    const pending = transport.request("thread/list", undefined, 5_000);
    resolveExit?.(1);

    await expect(pending).rejects.toThrow("exited unexpectedly");
  });
});
