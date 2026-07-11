// src/main.ts
import { PlayerPermissionLevel, system as system2, world as world4 } from "@minecraft/server";

// src/config.ts
var DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  shareHealth: true,
  shareHunger: true,
  shareInventory: true,
  shareEquipment: true,
  shareExperience: true,
  shareEffects: true,
  shareSelectedSlot: false,
  shareDeath: true,
  allowLateJoining: true,
  saveStateBetweenSessions: true,
  reconciliationIntervalTicks: 1,
  persistenceIntervalTicks: 100,
  joinApplyDelayTicks: 1,
  respawnGraceTicks: 10,
  applyLockTicks: 2,
  conflictMode: "deterministic",
  excludeCreative: true,
  excludeSpectator: true,
  diagnosticsLevel: "errors",
  logLevel: "info"
});
function validateConfig(config) {
  for (const key of ["reconciliationIntervalTicks", "persistenceIntervalTicks", "joinApplyDelayTicks", "respawnGraceTicks"]) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid CloneCraft config: ${key}`);
  }
  if (!Number.isInteger(config.applyLockTicks) || config.applyLockTicks < 1) throw new Error("Invalid CloneCraft config: applyLockTicks");
}

// src/sync/coordinator.ts
import { EntityComponentTypes as EntityComponentTypes2, system, world as world2 } from "@minecraft/server";

// src/model/sharedState.ts
function emptyState(enabled) {
  return { schemaVersion: 1, initialized: false, epoch: 0, dirty: false, enabled, health: 20, hunger: 20, saturation: 5, inventory: Array(36).fill(void 0), equipment: { head: void 0, chest: void 0, legs: void 0, feet: void 0, offhand: void 0 }, totalXp: 0, effects: [], selectedSlot: 0, death: { phase: "alive", generation: 0, expectedPlayerIds: [], respawnedPlayerIds: [] }, lastCommitTick: 0 };
}
function cloneState(state) {
  return { ...state, inventory: state.inventory.map((item) => item?.clone()), equipment: Object.fromEntries(Object.entries(state.equipment).map(([k, v]) => [k, v?.clone()])), effects: state.effects.map((effect) => ({ ...effect })), death: { ...state.death, expectedPlayerIds: [...state.death.expectedPlayerIds], respawnedPlayerIds: [...state.death.respawnedPlayerIds] } };
}

// src/pool/persistence.ts
import { world } from "@minecraft/server";

// src/utilities/logging.ts
function log(level, subsystem, message, tick = -1, epoch = -1) {
  const line = `[CloneCraft][${level}][${subsystem}][t=${tick}][e=${epoch}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// src/inventory/itemCodec.ts
import { ItemStack, ItemLockMode } from "@minecraft/server";
function encode(item) {
  if (!item) return void 0;
  const dynamicProperties = {};
  for (const id of item.getDynamicPropertyIds()) {
    const value = item.getDynamicProperty(id);
    if (value !== void 0) dynamicProperties[id] = value;
  }
  let durability;
  try {
    durability = { damage: item.getComponent("minecraft:durability").damage };
  } catch {
  }
  return { typeId: item.typeId, amount: item.amount, nameTag: item.nameTag, lore: item.getLore(), durability, keepOnDeath: item.keepOnDeath, lockMode: String(item.lockMode), canDestroy: item.getCanDestroy(), canPlaceOn: item.getCanPlaceOn(), dynamicProperties };
}
function decode(value) {
  if (!value || typeof value.typeId !== "string" || !Number.isInteger(value.amount) || value.amount < 1 || value.amount > 255) return void 0;
  try {
    const item = new ItemStack(value.typeId, value.amount);
    item.nameTag = value.nameTag;
    if (Array.isArray(value.lore)) item.setLore(value.lore.slice(0, 100));
    item.keepOnDeath = value.keepOnDeath === true;
    if (value.lockMode in ItemLockMode) item.lockMode = ItemLockMode[value.lockMode];
    for (const [id, property] of Object.entries(value.dynamicProperties ?? {})) item.setDynamicProperty(id, property);
    if (value.durability) {
      const durability = item.getComponent("minecraft:durability");
      if (durability) durability.damage = value.durability.damage;
    }
    return item;
  } catch {
    return void 0;
  }
}

// src/pool/persistence.ts
var META = "clonecraft:meta";
var CHUNK_PREFIX = "clonecraft:state_chunk_";
var CHECKSUM = "clonecraft:state_checksum";
var CHUNK_SIZE = 24e3;
function checksum(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
var Persistence = class {
  load() {
    try {
      const metaRaw = world.getDynamicProperty(META);
      if (typeof metaRaw !== "string") return void 0;
      const meta = JSON.parse(metaRaw);
      if (meta.schemaVersion !== 1 || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 128) return void 0;
      const raw = Array.from({ length: meta.chunks }, (_, index) => world.getDynamicProperty(`${CHUNK_PREFIX}${index}`)).join("");
      if (checksum(raw) !== meta.checksum || world.getDynamicProperty(CHECKSUM) !== meta.checksum) return void 0;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.inventory) || parsed.inventory.length !== 36) return void 0;
      parsed.inventory = parsed.inventory.map(decode);
      parsed.equipment = Object.fromEntries(Object.entries(parsed.equipment ?? {}).map(([key, value]) => [key, decode(value)]));
      parsed.effects = Array.isArray(parsed.effects) ? parsed.effects.filter((effect) => typeof effect?.typeId === "string" && Number.isInteger(effect.amplifier) && Number.isInteger(effect.duration) && effect.duration > 0).map((effect) => ({ typeId: effect.typeId, amplifier: effect.amplifier, duration: effect.duration })) : [];
      return parsed;
    } catch (error) {
      log("error", "persistence", `Ignoring invalid saved state: ${String(error)}`);
      return void 0;
    }
  }
  save(state) {
    try {
      const raw = JSON.stringify({ ...state, inventory: state.inventory.map(encode), equipment: Object.fromEntries(Object.entries(state.equipment).map(([key, value]) => [key, encode(value)])) });
      const count = Math.ceil(raw.length / CHUNK_SIZE);
      if (count > 128) throw new Error("serialized state exceeds dynamic-property limits");
      const digest = checksum(raw);
      for (let index = 0; index < count; index++) world.setDynamicProperty(`${CHUNK_PREFIX}${index}`, raw.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
      world.setDynamicProperty(CHECKSUM, digest);
      world.setDynamicProperty(META, JSON.stringify({ schemaVersion: 1, chunks: count, checksum: digest, savedAt: Date.now() }));
    } catch (error) {
      log("error", "persistence", `Save failed: ${String(error)}`);
    }
  }
};

// src/utilities/applyLock.ts
function locked(runtime, tick) {
  return runtime.lockUntilTick > tick;
}
function acquire(runtime, tick, duration, epoch) {
  runtime.phase = "applying";
  runtime.lockUntilTick = tick + duration;
  runtime.appliedEpoch = epoch;
}

// src/inventory/snapshot.ts
import { EntityComponentTypes, EquipmentSlot } from "@minecraft/server";

// src/inventory/comparator.ts
function fingerprint(stack, includeAmount = true, includeDurability = true) {
  if (!stack) return "empty";
  let durability = "";
  if (includeDurability) try {
    const component = stack.getComponent("minecraft:durability");
    durability = `|d:${component?.damage ?? 0}/${component?.maxDurability ?? 0}`;
  } catch {
  }
  let enchantments = "";
  try {
    const component = stack.getComponent("minecraft:enchantable");
    enchantments = JSON.stringify((component?.getEnchantments?.() ?? []).map((e) => [e.type?.id ?? e.typeId, e.level]).sort());
  } catch {
  }
  const dynamics = stack.getDynamicPropertyIds().sort().map((key) => [key, stack.getDynamicProperty(key)]);
  return [stack.typeId, includeAmount ? stack.amount : "", stack.nameTag ?? "", JSON.stringify(stack.getLore()), durability, enchantments, JSON.stringify(dynamics), stack.keepOnDeath, String(stack.lockMode), JSON.stringify([...stack.getCanDestroy()].sort()), JSON.stringify([...stack.getCanPlaceOn()].sort())].join("|");
}
function exactEqual(a, b) {
  return fingerprint(a) === fingerprint(b);
}
function identityEqual(a, b) {
  return fingerprint(a, false, false) === fingerprint(b, false, false);
}

// src/inventory/snapshot.ts
var EQUIPMENT_SLOTS = [["head", EquipmentSlot.Head], ["chest", EquipmentSlot.Chest], ["legs", EquipmentSlot.Legs], ["feet", EquipmentSlot.Feet], ["offhand", EquipmentSlot.Offhand]];
function capture(player) {
  const inventory = player.getComponent(EntityComponentTypes.Inventory)?.container;
  const equipment = player.getComponent(EntityComponentTypes.Equippable);
  return { inventory: Array.from({ length: 36 }, (_, i) => inventory?.getItem(i)?.clone()), equipment: Object.fromEntries(EQUIPMENT_SLOTS.map(([key, slot]) => [key, equipment?.getEquipment(slot)?.clone()])) };
}
function write(player, snapshot) {
  const inventory = player.getComponent(EntityComponentTypes.Inventory)?.container;
  if (inventory) for (let i = 0; i < 36; i++) {
    const current = inventory.getItem(i);
    if (!exactEqual(current, snapshot.inventory[i])) inventory.setItem(i, snapshot.inventory[i]?.clone());
  }
  const equipment = player.getComponent(EntityComponentTypes.Equippable);
  if (equipment) for (const [key, slot] of EQUIPMENT_SLOTS) {
    const current = equipment.getEquipment(slot);
    if (!exactEqual(current, snapshot.equipment[key])) equipment.setEquipment(slot, snapshot.equipment[key]?.clone());
  }
}

// src/inventory/transactionQueue.ts
function resolveInventory(initial, intents) {
  const inventory = initial.map((item) => item?.clone());
  const accepted = [], rejected = [];
  const ordered = [...intents].sort((a, b) => a.sourceTick - b.sourceTick || a.playerId.localeCompare(b.playerId) || a.slot - b.slot || a.sequence - b.sequence);
  for (const intent of ordered) {
    if (intent.slot < 0 || intent.slot >= inventory.length || !exactEqual(inventory[intent.slot], intent.before)) {
      rejected.push(intent);
      continue;
    }
    if (intent.after && intent.after.amount > intent.after.maxAmount) {
      rejected.push(intent);
      continue;
    }
    inventory[intent.slot] = intent.after?.clone();
    accepted.push(intent);
  }
  return { inventory, accepted, rejected };
}
function diffInventory(before, after, playerId, sourceTick) {
  const intents = [];
  for (let slot = 0; slot < Math.max(before.length, after.length); slot++) if (!exactEqual(before[slot], after[slot])) intents.push({ playerId, sourceTick, slot, before: before[slot]?.clone(), after: after[slot]?.clone(), sequence: slot });
  return intents;
}

// src/sync/coordinator.ts
var Coordinator = class {
  constructor(config, pool2) {
    this.config = config;
    this.pool = pool2;
    this.tick = 0;
    this.persistence = new Persistence();
    this.started = false;
    this.replicationPending = false;
    this.passiveDeltas = {
      healthRegen: /* @__PURE__ */ new Set(),
      hungerDrain: /* @__PURE__ */ new Set(),
      saturationDrain: /* @__PURE__ */ new Set()
    };
    this.state = emptyState(config.enabled);
  }
  get snapshot() {
    return cloneState(this.state);
  }
  isStarted() {
    return this.started;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.state = this.persistence.load() ?? emptyState(this.config.enabled);
    system.runInterval(() => this.reconcile(), this.config.reconciliationIntervalTicks);
    system.runInterval(() => {
      if (this.state.dirty && this.config.saveStateBetweenSessions) {
        this.persistence.save(this.state);
        this.state.dirty = false;
      }
    }, this.config.persistenceIntervalTicks);
  }
  admit(player) {
    const runtime = this.pool.join(player, this.tick);
    if (!runtime) {
      this.message(player, "You are excluded because your game mode is not supported.");
      return;
    }
    system.runTimeout(() => this.applyOrInitialize(player), this.config.joinApplyDelayTicks);
  }
  markRespawn(player) {
    const runtime = this.pool.join(player, this.tick);
    if (!runtime || this.state.death.phase === "alive") {
      if (runtime) this.admit(player);
      return;
    }
    if (!this.state.death.respawnedPlayerIds.includes(player.id)) this.state.death.respawnedPlayerIds.push(player.id);
    if (this.state.death.expectedPlayerIds.every((id) => this.state.death.respawnedPlayerIds.includes(id))) {
      this.state.death.phase = "restoring";
      system.runTimeout(() => this.restoreAfterDeath(), this.config.respawnGraceTicks);
    }
  }
  remove(id) {
    if (this.state.death.expectedPlayerIds.includes(id)) this.state.death.expectedPlayerIds = this.state.death.expectedPlayerIds.filter((expected) => expected !== id);
    this.pool.leave(id);
    if (this.pool.players.size === 0 && this.state.dirty) {
      this.persistence.save(this.state);
      this.state.dirty = false;
    }
    if (this.state.death.phase === "waiting_for_respawns" && this.state.death.expectedPlayerIds.every((expected) => this.state.death.respawnedPlayerIds.includes(expected))) {
      this.state.death.phase = "restoring";
      system.runTimeout(() => this.restoreAfterDeath(), this.config.respawnGraceTicks);
    }
  }
  resync() {
    for (const player of this.pool.activePlayers()) this.apply(player);
  }
  setEnabled(value) {
    this.state.enabled = value;
    this.state.dirty = true;
  }
  saveNow() {
    this.persistence.save(this.state);
    this.state.dirty = false;
  }
  resetFrom(player) {
    this.state.initialized = false;
    this.initializeFrom(player);
  }
  setHealth(value) {
    if (!Number.isFinite(value)) return;
    this.state.health = Math.max(0, Math.min(1024, value));
    this.commit();
    if (this.state.health <= 0 && this.config.shareDeath) {
      const source = this.pool.activePlayers()[0];
      if (source) this.beginDeath(source);
    }
  }
  initializeFrom(player) {
    const health = this.componentValue(player, EntityComponentTypes2.Health) ?? 20;
    this.state.health = health;
    this.state.hunger = this.attribute(player, "minecraft:player.hunger") ?? 20;
    this.state.saturation = this.attribute(player, "minecraft:player.saturation") ?? 5;
    this.state.selectedSlot = player.selectedSlotIndex;
    this.state.totalXp = player.getTotalXp();
    this.state.effects = this.captureEffects(player);
    const snapshot = capture(player);
    this.state.inventory = snapshot.inventory;
    this.state.equipment = snapshot.equipment;
    const runtime = this.pool.runtime(player);
    if (runtime) {
      runtime.phase = "active";
      runtime.lastInventory = snapshot.inventory.map((item) => item?.clone());
      runtime.lastEquipment = snapshot.equipment;
      runtime.lastEffects = this.state.effects.map((effect) => ({ ...effect }));
      runtime.lastHealth = health;
      runtime.lastHunger = this.state.hunger;
      runtime.lastSaturation = this.state.saturation;
      runtime.lastXp = this.state.totalXp;
      runtime.lastSelectedSlot = this.state.selectedSlot;
    }
    this.state.initialized = true;
    this.commit();
    this.message(player, "Shared state initialized from you. Other eligible players will receive this state.");
  }
  applyOrInitialize(player) {
    if (!this.state.initialized) this.initializeFrom(player);
    else this.apply(player);
  }
  reconcile() {
    this.tick++;
    if (!this.state.enabled) return;
    this.advanceEffects();
    this.passiveDeltas.healthRegen.clear();
    this.passiveDeltas.hungerDrain.clear();
    this.passiveDeltas.saturationDrain.clear();
    for (const player of this.pool.activePlayers()) {
      const runtime = this.pool.runtime(player);
      if (!runtime) continue;
      runtime.lastSeenTick = this.tick;
      if (!this.state.initialized) {
        this.initializeFrom(player);
        continue;
      }
      if (!locked(runtime, this.tick) && runtime.phase === "applying") runtime.phase = "active";
      if (!locked(runtime, this.tick) && runtime.phase === "active") this.observe(player);
    }
    if (this.replicationPending) {
      this.replicationPending = false;
      this.resync();
    }
  }
  observe(player) {
    const r = this.pool.runtime(player);
    const health = this.componentValue(player, EntityComponentTypes2.Health);
    if (health !== void 0 && r.lastHealth !== void 0 && health !== r.lastHealth) {
      const delta = health - r.lastHealth;
      if (delta <= 0 || this.acceptPassiveDelta(this.passiveDeltas.healthRegen, delta)) {
        this.state.health = Math.max(0, this.state.health + delta);
        this.commit();
        if (delta < 0) this.playDamageForClones(player);
        if (this.state.health <= 0 && this.config.shareDeath) this.beginDeath(player);
      }
    }
    const hunger = this.attribute(player, "minecraft:player.hunger");
    if (hunger !== void 0 && r.lastHunger !== void 0 && hunger !== r.lastHunger) {
      const delta = hunger - r.lastHunger;
      if (delta >= 0 || this.acceptPassiveDelta(this.passiveDeltas.hungerDrain, delta)) {
        this.state.hunger = Math.max(0, Math.min(20, this.state.hunger + delta));
        this.commit();
      }
    }
    const saturation = this.attribute(player, "minecraft:player.saturation");
    if (saturation !== void 0 && r.lastSaturation !== void 0 && saturation !== r.lastSaturation) {
      const delta = saturation - r.lastSaturation;
      if (delta >= 0 || this.acceptPassiveDelta(this.passiveDeltas.saturationDrain, delta)) {
        this.state.saturation = Math.max(0, Math.min(20, this.state.saturation + delta));
        this.commit();
      }
    }
    const xp = player.getTotalXp();
    if (r.lastXp !== void 0 && xp !== r.lastXp) {
      this.state.totalXp = Math.max(0, this.state.totalXp + xp - r.lastXp);
      this.commit();
    }
    if (this.config.shareSelectedSlot && player.selectedSlotIndex !== r.lastSelectedSlot) {
      this.state.selectedSlot = player.selectedSlotIndex;
      this.commit();
    }
    const current = capture(player);
    const inventoryChanged = !!r.lastInventory && this.inventoryChanged(r.lastInventory, current.inventory);
    if (inventoryChanged) {
      const result = resolveInventory(this.state.inventory, diffInventory(r.lastInventory, current.inventory, player.id, this.tick));
      if (result.accepted.length) {
        this.state.inventory = result.inventory;
        this.commit();
      }
      if (result.rejected.length) {
        log("warn", "inventory", `Rejected ${result.rejected.length} conflicting inventory transaction(s) for ${player.name}`, this.tick, this.state.epoch);
        this.message(player, `Inventory conflict rejected ${result.rejected.length} change(s); your inventory was resynchronized.`);
      }
    }
    if (this.config.shareEquipment && r.lastEquipment && this.equipmentChanged(r.lastEquipment, current.equipment)) {
      if (inventoryChanged || this.isValidEquipmentWear(r.lastEquipment, current.equipment)) {
        this.state.equipment = current.equipment;
        this.commit();
      } else {
        log("warn", "equipment", `Rejected an unsupported equipment mutation for ${player.name}`, this.tick, this.state.epoch);
      }
    }
    const effects = this.captureEffects(player);
    if (this.config.shareEffects && r.lastEffects && this.effectIntentChanged(r.lastEffects, effects)) {
      this.state.effects = effects;
      this.commit();
    }
    this.refreshObservation(player);
  }
  apply(player) {
    const r = this.pool.runtime(player);
    if (!r) return;
    acquire(r, this.tick, this.config.applyLockTicks, this.state.epoch);
    try {
      const health = player.getComponent(EntityComponentTypes2.Health);
      const currentHealth = this.componentValue(player, EntityComponentTypes2.Health);
      const targetHealth = health ? Math.min(health.effectiveMax, Math.max(health.effectiveMin, this.state.health)) : void 0;
      if (this.config.shareHealth && health && currentHealth !== targetHealth) health.setCurrentValue(targetHealth);
      const hunger = this.attribute(player, "minecraft:player.hunger");
      if (this.config.shareHunger && hunger !== this.state.hunger) this.setAttribute(player, "minecraft:player.hunger", this.state.hunger);
      const saturation = this.attribute(player, "minecraft:player.saturation");
      if (this.config.shareHunger && saturation !== this.state.saturation) this.setAttribute(player, "minecraft:player.saturation", this.state.saturation);
      if (this.config.shareSelectedSlot && player.selectedSlotIndex !== this.state.selectedSlot) player.selectedSlotIndex = this.state.selectedSlot;
      if (this.config.shareExperience && player.getTotalXp() !== this.state.totalXp) {
        player.resetLevel();
        if (this.state.totalXp > 0) player.addExperience(this.state.totalXp);
      }
      if (this.config.shareEffects) this.applyEffects(player);
      if (this.config.shareInventory || this.config.shareEquipment) write(player, { inventory: this.state.inventory, equipment: this.state.equipment });
      const snapshot = capture(player);
      r.lastHealth = this.componentValue(player, EntityComponentTypes2.Health);
      r.lastHunger = this.attribute(player, "minecraft:player.hunger");
      r.lastSaturation = this.attribute(player, "minecraft:player.saturation");
      r.lastXp = player.getTotalXp();
      r.lastSelectedSlot = player.selectedSlotIndex;
      r.lastInventory = snapshot.inventory;
      r.lastEquipment = snapshot.equipment;
      r.lastEffects = this.captureEffects(player);
    } catch (error) {
      log("error", "coordinator", `Replica apply failed for ${player.name}: ${String(error)}`, this.tick, this.state.epoch);
      this.message(player, `CloneCraft error: apply failed for this player.`);
    }
  }
  inventoryChanged(before, after) {
    return before.some((item, index) => !exactEqual(item, after[index]));
  }
  equipmentChanged(before, after) {
    return Object.keys(before).some((key) => !exactEqual(before[key], after[key]));
  }
  isValidEquipmentWear(before, after) {
    return Object.keys(before).every((key) => exactEqual(before[key], after[key]) || !!before[key] && (!after[key] || identityEqual(before[key], after[key])));
  }
  beginDeath(source) {
    if (this.state.death.phase !== "alive") return;
    const participants = this.pool.activePlayers();
    if (!participants.some((player) => player.id === source.id)) return;
    const dropper = participants.find((player) => player.id === source.id) ?? participants[0];
    const keepInventory = this.keepInventory();
    const sharedSnapshot = { inventory: this.state.inventory, equipment: this.state.equipment };
    this.state.death = { phase: "killing", generation: this.state.death.generation + 1, expectedPlayerIds: participants.map((player) => player.id), respawnedPlayerIds: [] };
    this.state.health = 0;
    this.state.totalXp = 0;
    this.state.effects = [];
    if (!keepInventory) {
      const dropperHealth = this.componentValue(dropper, EntityComponentTypes2.Health);
      if (dropperHealth === void 0 || dropperHealth > 0) write(dropper, sharedSnapshot);
      for (const player of participants) if (player.id !== dropper.id) this.clearReplicaBeforeDeath(player);
      this.state.inventory = Array(36).fill(void 0);
      this.state.equipment = { head: void 0, chest: void 0, legs: void 0, feet: void 0, offhand: void 0 };
    }
    for (const player of participants) this.clearExperienceBeforeDeath(player);
    this.commit();
    for (const player of participants) {
      try {
        this.pool.runtime(player).phase = "dead";
        player.kill();
      } catch (error) {
        log("error", "death", `Could not kill ${player.name}: ${String(error)}`);
      }
    }
    this.state.death.phase = "waiting_for_respawns";
    log("warn", "death", `Shared death generation ${this.state.death.generation} started from ${source.name}; ${dropper.name} is the only item drop source.`);
    this.message(source, "Shared death started; waiting for all clones to respawn.");
  }
  keepInventory() {
    try {
      return world2.gameRules.keepInventory;
    } catch {
      return false;
    }
  }
  restoreAfterDeath() {
    if (this.state.death.phase !== "restoring") return;
    const players = world2.getAllPlayers().filter((player) => this.state.death.expectedPlayerIds.includes(player.id));
    const healthMaxima = players.map((player) => this.componentMaximum(player, EntityComponentTypes2.Health)).filter((value) => value !== void 0);
    this.state.health = Math.max(1, Math.min(...healthMaxima.length ? healthMaxima : [20]));
    this.state.hunger = 20;
    this.state.saturation = 5;
    this.state.death.phase = "alive";
    this.commit();
    for (const player of players) {
      const runtime = this.pool.runtime(player);
      if (runtime) runtime.phase = "pending_spawn";
      this.apply(player);
    }
    log("info", "death", `Shared death generation ${this.state.death.generation} restored`);
  }
  refreshObservation(player) {
    const runtime = this.pool.runtime(player);
    if (!runtime) return;
    const current = capture(player);
    runtime.lastHealth = this.componentValue(player, EntityComponentTypes2.Health);
    runtime.lastHunger = this.attribute(player, "minecraft:player.hunger");
    runtime.lastSaturation = this.attribute(player, "minecraft:player.saturation");
    runtime.lastXp = player.getTotalXp();
    runtime.lastSelectedSlot = player.selectedSlotIndex;
    runtime.lastInventory = current.inventory.map((item) => item?.clone());
    runtime.lastEquipment = current.equipment;
    runtime.lastEffects = this.captureEffects(player);
  }
  message(player, message) {
    try {
      player.sendMessage(`\xA76[CloneCraft]\xA7r ${message}`);
    } catch {
    }
  }
  broadcast(message) {
    for (const player of this.pool.activePlayers()) this.message(player, message);
  }
  componentValue(player, component) {
    try {
      return player.getComponent(component)?.currentValue;
    } catch {
      return void 0;
    }
  }
  attribute(player, id) {
    return this.componentValue(player, id);
  }
  setAttribute(player, id, value) {
    try {
      player.getComponent(id)?.setCurrentValue(value);
    } catch {
    }
  }
  clearReplicaBeforeDeath(player) {
    try {
      write(player, { inventory: Array(36).fill(void 0), equipment: { head: void 0, chest: void 0, legs: void 0, feet: void 0, offhand: void 0 } });
    } catch (error) {
      log("error", "death", `Could not clear duplicate drops for ${player.name}: ${String(error)}`);
    }
  }
  clearExperienceBeforeDeath(player) {
    try {
      if (player.getTotalXp() !== 0) player.resetLevel();
    } catch (error) {
      log("error", "death", `Could not clear XP for ${player.name}: ${String(error)}`);
    }
  }
  captureEffects(player) {
    try {
      return player.getEffects().filter((effect) => effect.isValid && effect.duration > 0).map((effect) => ({ typeId: effect.typeId, amplifier: effect.amplifier, duration: effect.duration })).sort((a, b) => a.typeId.localeCompare(b.typeId));
    } catch {
      return [];
    }
  }
  advanceEffects() {
    if (!this.config.shareEffects || this.state.effects.length === 0) return;
    const effects = this.state.effects.map((effect) => ({ ...effect, duration: effect.duration - this.config.reconciliationIntervalTicks })).filter((effect) => effect.duration > 0);
    if (effects.length !== this.state.effects.length) this.state.dirty = true;
    this.state.effects = effects;
  }
  effectIntentChanged(before, after) {
    const previous = new Map(before.map((effect) => [effect.typeId, effect]));
    const current = new Map(after.map((effect) => [effect.typeId, effect]));
    if (previous.size !== current.size) return true;
    for (const [typeId, effect] of current) {
      const earlier = previous.get(typeId);
      if (!earlier || earlier.amplifier !== effect.amplifier || effect.duration > earlier.duration + this.config.reconciliationIntervalTicks) return true;
    }
    return false;
  }
  applyEffects(player) {
    const target = new Map(this.captureEffects(player).map((effect) => [effect.typeId, effect]));
    const shared = new Map(this.state.effects.map((effect) => [effect.typeId, effect]));
    for (const typeId of target.keys()) if (!shared.has(typeId)) player.removeEffect(typeId);
    for (const effect of this.state.effects) {
      const current = target.get(effect.typeId);
      if (!current || current.amplifier !== effect.amplifier || current.duration + this.config.applyLockTicks < effect.duration) player.addEffect(effect.typeId, effect.duration, { amplifier: effect.amplifier });
    }
  }
  componentMaximum(player, component) {
    try {
      return player.getComponent(component)?.effectiveMax;
    } catch {
      return void 0;
    }
  }
  acceptPassiveDelta(seen, delta) {
    if (seen.has(delta)) return false;
    seen.add(delta);
    return true;
  }
  playDamageForClones(source) {
    for (const player of this.pool.activePlayers()) if (player.id !== source.id) {
      try {
        player.playSound("damage.hurt");
      } catch {
      }
    }
  }
  commit() {
    this.state.epoch++;
    this.state.lastCommitTick = this.tick;
    this.state.dirty = true;
    this.replicationPending = true;
    const displayedHealth = Math.trunc(this.state.health);
    if (this.lastAnnouncedHealth !== displayedHealth) {
      this.lastAnnouncedHealth = displayedHealth;
      this.broadcast(`Shared health is now ${displayedHealth}.`);
    }
  }
};

// src/pool/playerPool.ts
import { GameMode, world as world3 } from "@minecraft/server";
var PlayerPool = class {
  constructor(config) {
    this.config = config;
    this.players = /* @__PURE__ */ new Map();
  }
  eligible(player) {
    const mode = player.getGameMode();
    return !(this.config.excludeCreative && mode === GameMode.Creative) && !(this.config.excludeSpectator && mode === GameMode.Spectator);
  }
  join(player, tick) {
    if (!this.eligible(player)) return void 0;
    const runtime = this.players.get(player.id) ?? { id: player.id, name: player.name, phase: "pending_spawn", appliedEpoch: 0, lockUntilTick: 0, joinedTick: tick, lastSeenTick: tick };
    runtime.lastSeenTick = tick;
    runtime.name = player.name;
    this.players.set(player.id, runtime);
    return runtime;
  }
  leave(id) {
    this.players.delete(id);
  }
  activePlayers() {
    return world3.getAllPlayers().filter((p) => {
      const r = this.players.get(p.id);
      return (r?.phase === "active" || r?.phase === "applying") && this.eligible(p);
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
  runtime(player) {
    return this.players.get(player.id);
  }
  status() {
    return `pool=${this.players.size} active=${[...this.players.values()].filter((p) => p.phase === "active").length}`;
  }
};

// src/main.ts
validateConfig(DEFAULT_CONFIG);
var pool = new PlayerPool(DEFAULT_CONFIG);
var coordinator = new Coordinator(DEFAULT_CONFIG, pool);
world4.afterEvents.playerJoin.subscribe((event) => {
  const player = world4.getAllPlayers().find((candidate) => candidate.id === event.playerId);
  if (player) coordinator.admit(player);
});
world4.afterEvents.playerSpawn.subscribe((event) => {
  if (event.initialSpawn) coordinator.admit(event.player);
  else coordinator.markRespawn(event.player);
});
world4.afterEvents.entityDie.subscribe((event) => {
  const player = event.deadEntity.typeId === "minecraft:player" ? event.deadEntity : void 0;
  if (player) coordinator.beginDeath(player);
});
world4.afterEvents.playerGameModeChange.subscribe((event) => {
  if (!pool.eligible(event.player)) pool.leave(event.player.id);
});
world4.beforeEvents.playerLeave.subscribe((event) => coordinator.remove(event.player.id));
system2.afterEvents.scriptEventReceive.subscribe((event) => {
  if (!event.id.startsWith("clonecraft:")) return;
  const command = event.id.slice("clonecraft:".length);
  const source = event.sourceEntity;
  const sourcePlayer = source?.typeId === "minecraft:player" ? source : void 0;
  if (sourcePlayer && sourcePlayer.playerPermissionLevel < PlayerPermissionLevel.Operator) {
    sourcePlayer.sendMessage("CloneCraft: operator permission required.");
    return;
  }
  const args = event.message.trim().split(/\s+/).filter(Boolean);
  switch (command) {
    case "enable":
      coordinator.setEnabled(true);
      break;
    case "disable":
      coordinator.setEnabled(false);
      break;
    case "resync":
      coordinator.resync();
      break;
    case "status": {
      const state = coordinator.snapshot;
      const message = `${pool.status()} initialized=${state.initialized} enabled=${state.enabled} epoch=${state.epoch} phase=${state.death.phase} dirty=${state.dirty}`;
      log("info", "admin", message);
      sourcePlayer?.sendMessage(`CloneCraft: ${message}`);
      break;
    }
    case "save":
      coordinator.saveNow();
      sourcePlayer?.sendMessage("CloneCraft: state saved.");
      break;
    case "reset": {
      const player = world4.getAllPlayers().filter((candidate) => pool.eligible(candidate)).sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!player) {
        sourcePlayer?.sendMessage("CloneCraft: reset requires an active player.");
        break;
      }
      coordinator.resetFrom(player);
      sourcePlayer?.sendMessage(`CloneCraft: reset from ${player.name}.`);
      break;
    }
    case "set_health": {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0 || value > 1024) {
        sourcePlayer?.sendMessage("CloneCraft: health must be 0..1024.");
        break;
      }
      coordinator.setHealth(value);
      sourcePlayer?.sendMessage(`CloneCraft: shared health set to ${value}.`);
      break;
    }
    default:
      log("warn", "admin", `Unknown command: ${command}`);
  }
});
function boot() {
  if (coordinator.isStarted()) return;
  coordinator.start();
  for (const player of world4.getAllPlayers()) coordinator.admit(player);
  world4.sendMessage("\xA7a[CloneCraft] \xA7fScript loaded successfully!");
  log("info", "main", "CloneCraft foundation loaded");
}
world4.afterEvents.worldLoad.subscribe(() => system2.run(boot));
system2.run(() => system2.run(boot));
