import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("@lydell/node-pty", () => ({
  spawn: spawnMock,
}));

function makePtyHandle() {
  let dataListener: ((value: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  return {
    pid: 123,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (value: string) => void) => {
      dataListener = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: vi.fn() };
    }),
    emitData(value: string) {
      dataListener?.(value);
    },
    emitExit(code: number) {
      exitListener?.({ exitCode: code });
    },
  };
}

describe("gateway pty manager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OPENCLAW_PTY_MAX_SESSIONS_PER_OWNER;
    delete process.env.OPENCLAW_PTY_MAX_TOTAL_SESSIONS;
    delete process.env.OPENCLAW_PTY_MAX_INPUT_CHUNK_BYTES;
    delete process.env.OPENCLAW_PTY_MIN_COLS;
    delete process.env.OPENCLAW_PTY_MAX_COLS;
    delete process.env.OPENCLAW_PTY_MIN_ROWS;
    delete process.env.OPENCLAW_PTY_MAX_ROWS;
  });

  afterEach(async () => {
    const mod = await import("./pty-manager.js");
    for (const session of mod.listGatewayPtySessionsByOwner("device:one")) {
      mod.destroyGatewayPtySession(session.sessionId);
    }
    for (const session of mod.listGatewayPtySessionsByOwner("device:two")) {
      mod.destroyGatewayPtySession(session.sessionId);
    }
  });

  it("enforces per-owner and total session limits", async () => {
    process.env.OPENCLAW_PTY_MAX_SESSIONS_PER_OWNER = "1";
    process.env.OPENCLAW_PTY_MAX_TOTAL_SESSIONS = "2";
    spawnMock.mockImplementation(() => makePtyHandle());
    const mod = await import("./pty-manager.js");

    await mod.createGatewayPtySession({
      owner: { ownerKey: "device:one", connId: "conn-1" },
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });
    await mod.createGatewayPtySession({
      owner: { ownerKey: "device:two", connId: "conn-2" },
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    await expect(
      mod.createGatewayPtySession({
        owner: { ownerKey: "device:one", connId: "conn-1" },
        onOutput: vi.fn(),
        onExit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "PTY_LIMIT_REACHED" });
  });

  it("enforces resize and input limits and exposes lastActive metadata", async () => {
    process.env.OPENCLAW_PTY_MAX_INPUT_CHUNK_BYTES = "4";
    process.env.OPENCLAW_PTY_MIN_COLS = "10";
    process.env.OPENCLAW_PTY_MAX_COLS = "100";
    process.env.OPENCLAW_PTY_MIN_ROWS = "5";
    process.env.OPENCLAW_PTY_MAX_ROWS = "50";
    const handle = makePtyHandle();
    spawnMock.mockImplementation(() => handle);
    const mod = await import("./pty-manager.js");

    const session = await mod.createGatewayPtySession({
      owner: { ownerKey: "device:one", connId: "conn-1" },
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(mod.listGatewayPtySessionsByOwner("device:one")[0]).toMatchObject({
      sessionId: session.sessionId,
      createdAt: expect.any(Number),
      lastActive: expect.any(Number),
      cols: 80,
      rows: 24,
    });

    expect(() => mod.writeGatewayPtySession(session.sessionId, "12345")).toThrowError(
      /exceeds 4 bytes/,
    );
    expect(() => mod.resizeGatewayPtySession(session.sessionId, 9, 6)).toThrowError(
      /cols must be between 10 and 100/,
    );
    expect(() => mod.resizeGatewayPtySession(session.sessionId, 20, 51)).toThrowError(
      /rows must be between 5 and 50/,
    );
  });

  it("kills sessions bound to a disconnected connection", async () => {
    const handle = makePtyHandle();
    spawnMock.mockImplementation(() => handle);
    const mod = await import("./pty-manager.js");

    const session = await mod.createGatewayPtySession({
      owner: { ownerKey: "device:one", connId: "conn-1" },
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(mod.destroyGatewayPtySessionsForConn("conn-1")).toBe(1);
    expect(mod.getGatewayPtySession(session.sessionId)).toBeUndefined();
  });
});
