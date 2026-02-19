import { describe, expect, test } from "bun:test";
import { CodexClient } from "../client";

const codexPath = Bun.which("codex");

if (!codexPath) {
  test("integration skipped (codex not found)", () => {
    expect(codexPath).toBeNull();
  });
} else {
  describe("CodexClient integration", () => {
    test("connect and list models", async () => {
      const client = new CodexClient();
      await client.connect();

      try {
        const models = await client.listModels();
        expect(Array.isArray(models.data)).toBe(true);
      } finally {
        await client.disconnect();
      }
    }, 120_000);

    test("start thread and run a simple turn", async () => {
      const client = new CodexClient();
      await client.connect();

      try {
        const thread = await client.startThread({});
        const result = await client.runTurn({
          threadId: thread.id,
          input: [{ type: "text", text: "echo hello world" }],
        });

        expect(typeof result.agentMessage).toBe("string");
      } finally {
        await client.disconnect();
      }
    }, 300_000);
  });
}
