import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const listAcpSessionEntriesMock = vi.hoisted(() => vi.fn());

vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: listAcpSessionEntriesMock,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => {
    throw new Error("gateway unavailable");
  }),
}));

import { resolveSessionKeyByReference } from "./session-target-resolution.js";

describe("resolveSessionKeyByReference", () => {
  it("matches ACP fallback session references case-insensitively", async () => {
    listAcpSessionEntriesMock.mockResolvedValueOnce([
      {
        sessionKey: "user:alice:acp:982649c1-1234-4abc-8123-0123456789ab",
      },
    ]);

    const resolved = await resolveSessionKeyByReference({
      cfg: {} as OpenClawConfig,
      token: "acp:982649C1-1234-4ABC-8123-0123456789AB",
    });

    expect(resolved).toBe("user:alice:acp:982649c1-1234-4abc-8123-0123456789ab");
  });
});
