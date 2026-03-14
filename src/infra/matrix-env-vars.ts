import { normalizeAccountId } from "../routing/session-key.js";

export function resolveMatrixEnvAccountToken(accountId: string): string {
  return Array.from(normalizeAccountId(accountId))
    .map((char) =>
      /[a-z0-9]/.test(char)
        ? char.toUpperCase()
        : `_X${char.codePointAt(0)?.toString(16).toUpperCase() ?? "00"}_`,
    )
    .join("");
}

export function getMatrixScopedEnvVarNames(accountId: string): {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
  deviceId: string;
  deviceName: string;
} {
  const token = resolveMatrixEnvAccountToken(accountId);
  return {
    homeserver: `MATRIX_${token}_HOMESERVER`,
    userId: `MATRIX_${token}_USER_ID`,
    accessToken: `MATRIX_${token}_ACCESS_TOKEN`,
    password: `MATRIX_${token}_PASSWORD`,
    deviceId: `MATRIX_${token}_DEVICE_ID`,
    deviceName: `MATRIX_${token}_DEVICE_NAME`,
  };
}
