import { ItemStack } from "@minecraft/server";
import { exactEqual, identityEqual } from "./comparator";

export interface InventoryIntent { playerId: string; sourceTick: number; slot: number; before?: ItemStack; after?: ItemStack; sequence: number; }
export interface ResolveResult { inventory: Array<ItemStack | undefined>; accepted: InventoryIntent[]; rejected: InventoryIntent[]; }
export function resolveInventory(initial: Array<ItemStack | undefined>, intents: InventoryIntent[]): ResolveResult {
  const inventory = initial.map(item => item?.clone());
  const accepted: InventoryIntent[] = [], rejected: InventoryIntent[] = [];
  const ordered = [...intents].sort((a, b) => a.sourceTick - b.sourceTick || a.playerId.localeCompare(b.playerId) || a.slot - b.slot || a.sequence - b.sequence);
  for (const intent of ordered) {
    if (intent.slot < 0 || intent.slot >= inventory.length || !exactEqual(inventory[intent.slot], intent.before)) { rejected.push(intent); continue; }
    if (intent.after && intent.after.amount > intent.after.maxAmount) { rejected.push(intent); continue; }
    inventory[intent.slot] = intent.after?.clone(); accepted.push(intent);
  }
  return { inventory, accepted, rejected };
}
export function diffInventory(before: Array<ItemStack | undefined>, after: Array<ItemStack | undefined>, playerId: string, sourceTick: number): InventoryIntent[] { const intents: InventoryIntent[] = []; for (let slot = 0; slot < Math.max(before.length, after.length); slot++) if (!exactEqual(before[slot], after[slot])) intents.push({ playerId, sourceTick, slot, before: before[slot]?.clone(), after: after[slot]?.clone(), sequence: slot }); return intents; }
export { identityEqual };
