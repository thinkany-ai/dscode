import { permissionSchema, type PermissionMode } from "./config.js";

export const SESSION_PERMISSION_ENTRY = "dscode-permission";

export interface RestoredSessionPermission {
  permission: PermissionMode;
  permissionBeforePlan: Exclude<PermissionMode, "plan">;
}

export function permissionFromSessionEntry(entry: unknown): PermissionMode | undefined {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_PERMISSION_ENTRY) {
    return undefined;
  }
  if (!isRecord(entry.data)) return undefined;
  const parsed = permissionSchema.safeParse(entry.data.permission);
  return parsed.success ? parsed.data : undefined;
}

export function restoreSessionPermission(
  entries: readonly unknown[],
  fallback: PermissionMode = "auto",
): RestoredSessionPermission {
  let permission = fallback;
  let permissionBeforePlan: Exclude<PermissionMode, "plan"> =
    fallback === "plan" ? "auto" : fallback;

  for (const entry of entries) {
    const restored = permissionFromSessionEntry(entry);
    if (!restored) continue;
    if (restored === "plan") {
      if (permission !== "plan") permissionBeforePlan = permission;
    } else {
      permissionBeforePlan = restored;
    }
    permission = restored;
  }

  return { permission, permissionBeforePlan };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
