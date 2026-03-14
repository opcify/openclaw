import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  assertGatewayPtyOwnership,
  createGatewayPtySession,
  destroyGatewayPtySession,
  GatewayPtyError,
  listGatewayPtySessionsByOwner,
  resizeGatewayPtySession,
  writeGatewayPtySession,
} from "../pty-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

function getPtyOwner(client: { connect?: { device?: { id?: string } }; connId?: string } | null): {
  ownerKey: string;
  connId: string;
  deviceId?: string;
} {
  const connId = client?.connId?.trim();
  if (!connId) {
    throw new GatewayPtyError(
      "PTY_INVALID_ARGS",
      "PTY requires an authenticated gateway connection",
    );
  }
  const deviceId = client?.connect?.device?.id?.trim() || undefined;
  return {
    ownerKey: deviceId ? `device:${deviceId}` : `conn:${connId}`,
    connId,
    deviceId,
  };
}

function invalidParams(message: string) {
  return errorShape(ErrorCodes.INVALID_PARAMS, message);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapPtyError(error: unknown) {
  if (error instanceof GatewayPtyError) {
    switch (error.code) {
      case "PTY_NOT_FOUND":
        return errorShape(ErrorCodes.NOT_FOUND, error.message);
      case "PTY_ACCESS_DENIED":
        return errorShape(ErrorCodes.FORBIDDEN, error.message);
      case "PTY_LIMIT_REACHED":
        return errorShape(ErrorCodes.RESOURCE_LIMIT, error.message);
      case "PTY_INPUT_TOO_LARGE":
        return errorShape(ErrorCodes.PAYLOAD_TOO_LARGE, error.message);
      case "PTY_INVALID_ARGS":
      default:
        return invalidParams(error.message);
    }
  }
  return invalidParams(error instanceof Error ? error.message : String(error));
}

export const ptyHandlers: GatewayRequestHandlers = {
  "pty.create": async ({ client, params, respond, context }) => {
    try {
      const owner = getPtyOwner(client);
      const session = await createGatewayPtySession({
        owner,
        cols: asNumber(params.cols),
        rows: asNumber(params.rows),
        cwd: asString(params.cwd),
        shell: asString(params.shell),
        onOutput: ({ sessionId, data, connId }) => {
          context.broadcastToConnIds("pty.output", { sessionId, data }, new Set([connId]));
        },
        onExit: ({ sessionId, code, connId }) => {
          context.broadcastToConnIds("pty.exit", { sessionId, code }, new Set([connId]));
        },
      });
      respond(true, { sessionId: session.sessionId, cwd: session.cwd, shell: session.shell });
    } catch (error) {
      respond(false, undefined, mapPtyError(error));
    }
  },
  "pty.write": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      const data = asString(params.data);
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.write requires sessionId"));
        return;
      }
      if (typeof data !== "string") {
        respond(false, undefined, invalidParams("pty.write requires string data"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      writeGatewayPtySession(sessionId, data);
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, mapPtyError(error));
    }
  },
  "pty.resize": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.resize requires sessionId"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      resizeGatewayPtySession(sessionId, asNumber(params.cols), asNumber(params.rows));
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, mapPtyError(error));
    }
  },
  "pty.kill": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.kill requires sessionId"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      destroyGatewayPtySession(sessionId);
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, mapPtyError(error));
    }
  },
  "pty.list": ({ client, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessions = listGatewayPtySessionsByOwner(owner.ownerKey).map((session) => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        lastActive: session.lastActive,
        cols: session.cols,
        rows: session.rows,
      }));
      respond(true, { sessions });
    } catch (error) {
      respond(false, undefined, mapPtyError(error));
    }
  },
};
