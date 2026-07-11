export interface CloneCraftConfig {
  enabled: boolean;
  shareHealth: boolean;
  shareHunger: boolean;
  shareInventory: boolean;
  shareEquipment: boolean;
  shareExperience: boolean;
  shareEffects: boolean;
  effectSyncExceptions: readonly string[];
  shareSelectedSlot: boolean;
  shareDeath: boolean;
  allowLateJoining: boolean;
  saveStateBetweenSessions: boolean;
  reconciliationIntervalTicks: number;
  persistenceIntervalTicks: number;
  joinApplyDelayTicks: number;
  respawnGraceTicks: number;
  applyLockTicks: number;
  conflictMode: "deterministic";
  excludeCreative: boolean;
  excludeSpectator: boolean;
  diagnosticsLevel: "off" | "errors" | "verbose";
  logLevel: "error" | "warn" | "info" | "debug";
}

export const DEFAULT_CONFIG: Readonly<CloneCraftConfig> = Object.freeze({
  enabled: true, shareHealth: true, shareHunger: true, shareInventory: true,
  shareEquipment: true, shareExperience: true, shareEffects: true,
  effectSyncExceptions: Object.freeze(["minecraft:wither", "minecraft:hunger", "minecraft:poison"]),
  shareSelectedSlot: false, shareDeath: true,
  allowLateJoining: true, saveStateBetweenSessions: true, reconciliationIntervalTicks: 1,
  persistenceIntervalTicks: 100, joinApplyDelayTicks: 1, respawnGraceTicks: 10,
  applyLockTicks: 2, conflictMode: "deterministic", excludeCreative: true,
  excludeSpectator: true, diagnosticsLevel: "errors", logLevel: "info",
});

export function validateConfig(config: CloneCraftConfig): void {
  for (const key of ["reconciliationIntervalTicks", "persistenceIntervalTicks", "joinApplyDelayTicks", "respawnGraceTicks"] as const) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid CloneCraft config: ${key}`);
  }
  if (!Number.isInteger(config.applyLockTicks) || config.applyLockTicks < 1) throw new Error("Invalid CloneCraft config: applyLockTicks");
}
