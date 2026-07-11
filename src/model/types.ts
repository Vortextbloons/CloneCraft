import { ItemStack } from "@minecraft/server";

export type EquipmentKey = "head" | "chest" | "legs" | "feet" | "offhand";
export type PlayerKey = string;
export interface SharedEffect { typeId: string; amplifier: number; duration: number; }
export interface SharedDeathState { phase: "alive" | "killing" | "waiting_for_respawns" | "restoring"; generation: number; expectedPlayerIds: string[]; respawnedPlayerIds: string[]; }
export interface SharedState {
  schemaVersion: 1; initialized: boolean; epoch: number; dirty: boolean; enabled: boolean;
  health: number; hunger: number; saturation: number; inventory: Array<ItemStack | undefined>;
  equipment: Record<EquipmentKey, ItemStack | undefined>; totalXp: number; effects: SharedEffect[]; selectedSlot: number;
  death: SharedDeathState; lastCommitTick: number;
}
export interface PlayerRuntime { id: PlayerKey; name: string; phase: "pending_spawn" | "applying" | "active" | "dead" | "excluded"; appliedEpoch: number; lockUntilTick: number; joinedTick: number; lastSeenTick: number; lastHealth?: number; lastHunger?: number; lastSaturation?: number; lastXp?: number; lastSelectedSlot?: number; lastInventory?: Array<any>; lastEquipment?: Record<EquipmentKey, any>; lastEffects?: SharedEffect[]; }
