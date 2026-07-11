import { EntityComponentTypes, EquipmentSlot, Player, ItemStack } from "@minecraft/server";
import { EquipmentKey } from "../model/types";
import { exactEqual } from "./comparator";

export const EQUIPMENT_SLOTS: ReadonlyArray<[EquipmentKey, EquipmentSlot]> = [["head", EquipmentSlot.Head], ["chest", EquipmentSlot.Chest], ["legs", EquipmentSlot.Legs], ["feet", EquipmentSlot.Feet], ["offhand", EquipmentSlot.Offhand]];
export interface LiveSnapshot { inventory: Array<ItemStack | undefined>; equipment: Record<EquipmentKey, ItemStack | undefined>; }
export function capture(player: Player): LiveSnapshot {
  const inventory = (player.getComponent(EntityComponentTypes.Inventory) as any)?.container;
  const equipment = (player.getComponent(EntityComponentTypes.Equippable) as any);
  return { inventory: Array.from({ length: 36 }, (_, i) => inventory?.getItem(i)?.clone()), equipment: Object.fromEntries(EQUIPMENT_SLOTS.map(([key, slot]) => [key, equipment?.getEquipment(slot)?.clone()])) as Record<EquipmentKey, ItemStack | undefined> };
}
export function write(player: Player, snapshot: LiveSnapshot): void {
  const inventory = (player.getComponent(EntityComponentTypes.Inventory) as any)?.container;
  if (inventory) for (let i = 0; i < 36; i++) {
    const current = inventory.getItem(i);
    if (!exactEqual(current, snapshot.inventory[i])) inventory.setItem(i, snapshot.inventory[i]?.clone());
  }
  const equipment = player.getComponent(EntityComponentTypes.Equippable) as any;
  if (equipment) for (const [key, slot] of EQUIPMENT_SLOTS) {
    const current = equipment.getEquipment(slot);
    if (!exactEqual(current, snapshot.equipment[key])) equipment.setEquipment(slot, snapshot.equipment[key]?.clone());
  }
}
