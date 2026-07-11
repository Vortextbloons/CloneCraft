import { ItemStack } from "@minecraft/server";

export function fingerprint(stack: ItemStack | undefined, includeAmount = true, includeDurability = true): string {
  if (!stack) return "empty";
  let durability = "";
  if (includeDurability) try { const component = stack.getComponent("minecraft:durability") as any; durability = `|d:${component?.damage ?? 0}/${component?.maxDurability ?? 0}`; } catch { /* unsupported */ }
  let enchantments = "";
  try { const component = stack.getComponent("minecraft:enchantable") as any; enchantments = JSON.stringify((component?.getEnchantments?.() ?? []).map((e: any) => [e.type?.id ?? e.typeId, e.level]).sort()); } catch { /* unsupported */ }
  const dynamics = stack.getDynamicPropertyIds().sort().map(key => [key, stack.getDynamicProperty(key)]);
  return [stack.typeId, includeAmount ? stack.amount : "", stack.nameTag ?? "", JSON.stringify(stack.getLore()), durability, enchantments, JSON.stringify(dynamics), stack.keepOnDeath, String(stack.lockMode), JSON.stringify([...stack.getCanDestroy()].sort()), JSON.stringify([...stack.getCanPlaceOn()].sort())].join("|");
}

export function exactEqual(a: ItemStack | undefined, b: ItemStack | undefined): boolean { return fingerprint(a) === fingerprint(b); }
// Identity deliberately excludes mutable amount and durability, so ordinary
// tool/armor wear remains a valid update to the same shared item.
export function identityEqual(a: ItemStack | undefined, b: ItemStack | undefined): boolean { return fingerprint(a, false, false) === fingerprint(b, false, false); }
