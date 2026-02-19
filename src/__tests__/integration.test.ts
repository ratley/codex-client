import { describe, expect, test } from "bun:test";
import { CodexClient } from "../client";
import { existsSync } from "node:fs";

// Try common locations for the codex binary
const CODEX_PATHS = [
  Bun.which("codex"),
  `${process.env.HOME}/.nvm/versions/node/v22.22.0/bin/codex`,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
].filter(Boolean) as string[];

const codexPath = CODEX_PATHS.find((p) => existsSync(p)) ?? null;

if (!codexPath) {
  test("integration skipped (codex not found)", () => {
    expect(codexPath).toBeNull();
  });
} else {
  describe("CodexClient integration", () => {
    test("connect and list models", async () => {
      const client = new CodexClient({ codexPath });
      await client.connect();

      try {
        const models = await client.listModels();
        expect(Array.isArray(models.data)).toBe(true);
        expect(models.data.length).toBeGreaterThan(0);
        console.log(`Found ${models.data.length} models`);
      } finally {
        await client.disconnect();
      }
    }, 120_000);

    test("start thread and run a simple turn", async () => {
      const client = new CodexClient({
        codexPath,
        cwd: "/tmp",
        approvalPolicy: "never",
      });
      await client.connect();

      try {
        const thread = await client.startThread({});
        expect(thread.id).toBeTruthy();
        console.log(`Thread started: ${thread.id}`);

        const result = await client.runTurn({
          threadId: thread.id,
          input: [{ type: "text", text: "Run: echo 'hello from codex client'" }],
        });

        expect(typeof result.agentMessage).toBe("string");
        expect(result.turn.status).toBe("completed");
        console.log(`Turn completed. Agent message length: ${result.agentMessage.length}`);
        console.log(`Items collected: ${result.items.length}`);
      } finally {
        await client.disconnect();
      }
    }, 300_000);

    test("thread resume preserves context", async () => {
      const client = new CodexClient({
        codexPath,
        cwd: "/tmp",
        approvalPolicy: "never",
      });
      await client.connect();

      let threadId: string;

      try {
        // First turn: establish context
        const thread = await client.startThread({});
        threadId = thread.id;

        const result1 = await client.runTurn({
          threadId,
          input: [{ type: "text", text: "Remember this: the secret word is 'papaya'. Confirm you've noted it." }],
        });

        expect(result1.turn.status).toBe("completed");
        console.log(`Turn 1 completed: ${result1.agentMessage.slice(0, 100)}`);

        // Second turn: test context retention within same session
        const result2 = await client.runTurn({
          threadId,
          input: [{ type: "text", text: "What was the secret word I just told you?" }],
        });

        expect(result2.turn.status).toBe("completed");
        const hasContext = result2.agentMessage.toLowerCase().includes("papaya");
        console.log(`Turn 2 response: ${result2.agentMessage.slice(0, 200)}`);
        console.log(`Context preserved: ${hasContext}`);
        expect(hasContext).toBe(true);
      } finally {
        await client.disconnect();
      }
    }, 300_000);
  });
}
