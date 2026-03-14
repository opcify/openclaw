import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export type GatewayPtyOwner = {
  ownerKey: string;
  connId: string;
  deviceId?: string;
};

export type GatewayPtySession = {
  sessionId: string;
  owner: GatewayPtyOwner;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActive: number;
  exitedAt?: number;
  exitCode?: number | null;
};

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyDisposable = { dispose: () => void };
type PtySpawnHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  resize?: (cols: number, rows: number) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable | void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtySpawnHandle;

type PtyModule = {
  spawn?: PtySpawn;
  default?: { spawn?: PtySpawn };
};

type ActiveSession = GatewayPtySession & {
  pty: PtySpawnHandle;
  outputDispose?: PtyDisposable | null;
  exitDispose?: PtyDisposable | null;
};

export class GatewayPtyError extends Error {
  code:
    | "PTY_NOT_FOUND"
    | "PTY_ACCESS_DENIED"
    | "PTY_INVALID_ARGS"
    | "PTY_LIMIT_REACHED"
    | "PTY_INPUT_TOO_LARGE";

  constructor(
    code:
      | "PTY_NOT_FOUND"
      | "PTY_ACCESS_DENIED"
      | "PTY_INVALID_ARGS"
      | "PTY_LIMIT_REACHED"
      | "PTY_INPUT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "GatewayPtyError";
    this.code = code;
  }
}

const sessions = new Map<string, ActiveSession>();
let idleSweepTimer: NodeJS.Timeout | null = null;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function getPtyLimits() {
  const minCols = Math.max(1, intFromEnv("OPENCLAW_PTY_MIN_COLS", 20));
  const maxCols = Math.max(minCols, intFromEnv("OPENCLAW_PTY_MAX_COLS", 500));
  const minRows = Math.max(1, intFromEnv("OPENCLAW_PTY_MIN_ROWS", 5));
  const maxRows = Math.max(minRows, intFromEnv("OPENCLAW_PTY_MAX_ROWS", 200));
  return {
    minCols,
    maxCols,
    minRows,
    maxRows,
    maxSessionsPerOwner: Math.max(1, intFromEnv("OPENCLAW_PTY_MAX_SESSIONS_PER_OWNER", 4)),
    maxTotalSessions: Math.max(1, intFromEnv("OPENCLAW_PTY_MAX_TOTAL_SESSIONS", 32)),
    maxInputChunkBytes: Math.max(1, intFromEnv("OPENCLAW_PTY_MAX_INPUT_CHUNK_BYTES", 65536)),
    idleTimeoutMs: Math.max(0, intFromEnv("OPENCLAW_PTY_IDLE_TIMEOUT_MS", 30 * 60 * 1000)),
    idleSweepIntervalMs: Math.max(
      1000,
      intFromEnv("OPENCLAW_PTY_IDLE_SWEEP_INTERVAL_MS", 60 * 1000),
    ),
  };
}

function sanitizeInitialDim(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value == null) {
    return fallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new GatewayPtyError("PTY_INVALID_ARGS", `${label} must be a finite number`);
  }
  const next = Math.floor(n);
  if (next < min || next > max) {
    throw new GatewayPtyError("PTY_INVALID_ARGS", `${label} must be between ${min} and ${max}`);
  }
  return next;
}

function sanitizeResizeDim(
  value: unknown,
  current: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value == null) {
    return current;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new GatewayPtyError("PTY_INVALID_ARGS", `${label} must be a finite number`);
  }
  const next = Math.floor(n);
  if (next < min || next > max) {
    throw new GatewayPtyError("PTY_INVALID_ARGS", `${label} must be between ${min} and ${max}`);
  }
  return next;
}

function resolveDefaultShell(): string {
  const shell = (process.env.OPENCLAW_PTY_SHELL || process.env.SHELL || "").trim();
  if (shell) {
    return shell;
  }
  return process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
}

function resolveAllowedShells(defaultShell: string): Set<string> {
  const raw = (process.env.OPENCLAW_PTY_ALLOWED_SHELLS || "").trim();
  const values = raw
    ? raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : [defaultShell];
  return new Set(values);
}

function resolveShell(requested?: string): string {
  const defaultShell = resolveDefaultShell();
  if (!requested?.trim()) {
    return defaultShell;
  }
  const candidate = requested.trim();
  const allowed = resolveAllowedShells(defaultShell);
  if (!allowed.has(candidate)) {
    throw new GatewayPtyError("PTY_INVALID_ARGS", `shell is not allowed: ${candidate}`);
  }
  return candidate;
}

function resolveCwd(requested?: string): string {
  const base = process.env.OPENCLAW_PTY_CWD || process.cwd();
  const home = os.homedir();
  const fallback = path.resolve(base || home);
  if (!requested?.trim()) {
    return fallback;
  }
  const expanded = requested.startsWith("~/") ? path.join(home, requested.slice(2)) : requested;
  return path.resolve(expanded);
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

async function loadSpawn(): Promise<PtySpawn> {
  const mod = (await import("@lydell/node-pty")) as unknown as PtyModule;
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable");
  }
  return spawn;
}

function publicSession(session: ActiveSession): GatewayPtySession {
  return {
    sessionId: session.sessionId,
    owner: { ...session.owner },
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
    exitedAt: session.exitedAt,
    exitCode: session.exitCode,
  };
}

function markActive(session: ActiveSession): void {
  session.lastActive = Date.now();
}

function ensureCapacity(ownerKey: string): void {
  const limits = getPtyLimits();
  if (sessions.size >= limits.maxTotalSessions) {
    throw new GatewayPtyError(
      "PTY_LIMIT_REACHED",
      `PTY session limit reached (${limits.maxTotalSessions} total)`,
    );
  }
  const ownerSessions = Array.from(sessions.values()).filter(
    (session) => session.owner.ownerKey === ownerKey,
  );
  if (ownerSessions.length >= limits.maxSessionsPerOwner) {
    throw new GatewayPtyError(
      "PTY_LIMIT_REACHED",
      `PTY session limit reached (${limits.maxSessionsPerOwner} per owner)`,
    );
  }
}

function ensureIdleSweep(): void {
  const { idleTimeoutMs, idleSweepIntervalMs } = getPtyLimits();
  if (idleTimeoutMs <= 0) {
    if (idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }
    return;
  }
  if (idleSweepTimer) {
    return;
  }
  idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastActive >= idleTimeoutMs) {
        destroyGatewayPtySession(session.sessionId);
      }
    }
    if (sessions.size === 0 && idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }
  }, idleSweepIntervalMs);
  idleSweepTimer.unref?.();
}

export async function createGatewayPtySession(params: {
  owner: GatewayPtyOwner;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  onOutput: (event: { sessionId: string; data: string; connId: string }) => void;
  onExit: (event: { sessionId: string; code: number | null; connId: string }) => void;
}): Promise<GatewayPtySession> {
  ensureCapacity(params.owner.ownerKey);
  const spawn = await loadSpawn();
  const limits = getPtyLimits();
  const cols = sanitizeInitialDim(params.cols, 80, limits.minCols, limits.maxCols, "cols");
  const rows = sanitizeInitialDim(params.rows, 24, limits.minRows, limits.maxRows, "rows");
  const shell = resolveShell(params.shell);
  const cwd = resolveCwd(params.cwd);
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const pty = spawn(shell, [], {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd,
    env: toStringEnv(process.env),
  });
  const session: ActiveSession = {
    sessionId,
    owner: { ...params.owner },
    shell,
    cwd,
    cols,
    rows,
    createdAt: now,
    lastActive: now,
    pty,
  };
  session.outputDispose =
    pty.onData((data) => {
      markActive(session);
      params.onOutput({ sessionId, data, connId: session.owner.connId });
    }) ?? null;
  session.exitDispose =
    pty.onExit((event) => {
      session.exitedAt = Date.now();
      session.exitCode = event.exitCode ?? null;
      try {
        params.onExit({ sessionId, code: session.exitCode, connId: session.owner.connId });
      } finally {
        destroyGatewayPtySession(sessionId);
      }
    }) ?? null;
  sessions.set(sessionId, session);
  ensureIdleSweep();
  return publicSession(session);
}

export function listGatewayPtySessionsByOwner(ownerKey: string): GatewayPtySession[] {
  return Array.from(sessions.values())
    .filter((session) => session.owner.ownerKey === ownerKey)
    .map(publicSession);
}

export function getGatewayPtySession(sessionId: string): GatewayPtySession | undefined {
  const session = sessions.get(sessionId);
  return session ? publicSession(session) : undefined;
}

export function touchGatewayPtySessionOwner(params: { sessionId: string; connId: string }): void {
  const session = sessions.get(params.sessionId);
  if (!session) {
    return;
  }
  session.owner.connId = params.connId;
  markActive(session);
}

export function writeGatewayPtySession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new GatewayPtyError("PTY_NOT_FOUND", `PTY session not found: ${sessionId}`);
  }
  const byteLength = Buffer.byteLength(data, "utf8");
  const { maxInputChunkBytes } = getPtyLimits();
  if (byteLength > maxInputChunkBytes) {
    throw new GatewayPtyError(
      "PTY_INPUT_TOO_LARGE",
      `PTY input exceeds ${maxInputChunkBytes} bytes`,
    );
  }
  markActive(session);
  session.pty.write(data);
}

export function resizeGatewayPtySession(sessionId: string, cols?: number, rows?: number): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new GatewayPtyError("PTY_NOT_FOUND", `PTY session not found: ${sessionId}`);
  }
  const limits = getPtyLimits();
  const nextCols = sanitizeResizeDim(cols, session.cols, limits.minCols, limits.maxCols, "cols");
  const nextRows = sanitizeResizeDim(rows, session.rows, limits.minRows, limits.maxRows, "rows");
  session.cols = nextCols;
  session.rows = nextRows;
  markActive(session);
  session.pty.resize?.(nextCols, nextRows);
}

export function destroyGatewayPtySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  sessions.delete(sessionId);
  try {
    session.outputDispose?.dispose();
  } catch {}
  try {
    session.exitDispose?.dispose();
  } catch {}
  try {
    session.pty.kill("SIGKILL");
  } catch {}
  if (sessions.size === 0 && idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
}

export function destroyGatewayPtySessionsForConn(connId: string): number {
  const sessionIds = Array.from(sessions.values())
    .filter((session) => session.owner.connId === connId)
    .map((session) => session.sessionId);
  for (const sessionId of sessionIds) {
    destroyGatewayPtySession(sessionId);
  }
  return sessionIds.length;
}

export function assertGatewayPtyOwnership(params: {
  sessionId: string;
  ownerKey: string;
  connId: string;
}): GatewayPtySession {
  const session = sessions.get(params.sessionId);
  if (!session) {
    throw new GatewayPtyError("PTY_NOT_FOUND", `PTY session not found: ${params.sessionId}`);
  }
  if (session.owner.ownerKey !== params.ownerKey) {
    throw new GatewayPtyError(
      "PTY_ACCESS_DENIED",
      `PTY session does not belong to this gateway client: ${params.sessionId}`,
    );
  }
  session.owner.connId = params.connId;
  markActive(session);
  return publicSession(session);
}
