import { EntityComponentTypes, Player, system, world } from "@minecraft/server";
import { CloneCraftConfig } from "../config";
import { cloneState } from "../model/sharedState";
import { SharedState } from "../model/types";
import { Persistence } from "../pool/persistence";
import { PlayerPool } from "../pool/playerPool";
import { acquire, locked } from "../utilities/applyLock";
import { log } from "../utilities/logging";
import { capture, write } from "../inventory/snapshot";
import { exactEqual, identityEqual } from "../inventory/comparator";
import { diffInventory, resolveInventory } from "../inventory/transactionQueue";
import { emptyState } from "../model/sharedState";

export class Coordinator {
  private tick = 0;
  private state: SharedState;
  private readonly persistence = new Persistence();
  private started = false;
  private replicationPending = false;
  private lastAnnouncedHealth?: number;
  private readonly passiveDeltas = {
    healthRegen: new Set<number>(),
    hungerDrain: new Set<number>(),
    saturationDrain: new Set<number>(),
  };
  constructor(private readonly config: CloneCraftConfig, private readonly pool: PlayerPool) {
    this.state = emptyState(config.enabled);
  }
  get snapshot(): SharedState { return cloneState(this.state); }
  isStarted(): boolean { return this.started; }
  start(): void { if (this.started) return; this.started = true; this.state = this.persistence.load() ?? emptyState(this.config.enabled); system.runInterval(() => this.reconcile(), this.config.reconciliationIntervalTicks); system.runInterval(() => { if (this.state.dirty && this.config.saveStateBetweenSessions) { this.persistence.save(this.state); this.state.dirty = false; } }, this.config.persistenceIntervalTicks); }
  admit(player: Player): void { const runtime = this.pool.join(player, this.tick); if (!runtime) { this.message(player, "You are excluded because your game mode is not supported."); return; } system.runTimeout(() => this.applyOrInitialize(player), this.config.joinApplyDelayTicks); }
  markRespawn(player: Player): void { const runtime = this.pool.join(player, this.tick); if (!runtime || this.state.death.phase === "alive") { if (runtime) this.admit(player); return; } if (!this.state.death.respawnedPlayerIds.includes(player.id)) this.state.death.respawnedPlayerIds.push(player.id); if (this.state.death.expectedPlayerIds.every(id => this.state.death.respawnedPlayerIds.includes(id))) { this.state.death.phase = "restoring"; system.runTimeout(() => this.restoreAfterDeath(), this.config.respawnGraceTicks); } }
  remove(id: string): void { if (this.state.death.expectedPlayerIds.includes(id)) this.state.death.expectedPlayerIds = this.state.death.expectedPlayerIds.filter(expected => expected !== id); this.pool.leave(id); if (this.pool.players.size === 0 && this.state.dirty) { this.persistence.save(this.state); this.state.dirty = false; } if (this.state.death.phase === "waiting_for_respawns" && this.state.death.expectedPlayerIds.every(expected => this.state.death.respawnedPlayerIds.includes(expected))) { this.state.death.phase = "restoring"; system.runTimeout(() => this.restoreAfterDeath(), this.config.respawnGraceTicks); } }
  resync(): void { for (const player of this.pool.activePlayers()) this.apply(player); }
  setEnabled(value: boolean): void { this.state.enabled = value; this.state.dirty = true; }
  saveNow(): void { this.persistence.save(this.state); this.state.dirty = false; }
  resetFrom(player: Player): void { this.state.initialized = false; this.initializeFrom(player); }
  setHealth(value: number): void { if (!Number.isFinite(value)) return; this.state.health = Math.max(0, Math.min(1024, value)); this.commit(); if (this.state.health <= 0 && this.config.shareDeath) { const source = this.pool.activePlayers()[0]; if (source) this.beginDeath(source); } }
  initializeFrom(player: Player): void { const health = this.componentValue(player, EntityComponentTypes.Health) ?? 20; this.state.health = health; this.state.hunger = this.attribute(player, "minecraft:player.hunger") ?? 20; this.state.saturation = this.attribute(player, "minecraft:player.saturation") ?? 5; this.state.selectedSlot = player.selectedSlotIndex; this.state.totalXp = player.getTotalXp(); this.state.effects = this.captureEffects(player); const snapshot = capture(player); this.state.inventory = snapshot.inventory; this.state.equipment = snapshot.equipment; const runtime = this.pool.runtime(player); if (runtime) { runtime.phase = "active"; runtime.lastInventory = snapshot.inventory.map(item => item?.clone()); runtime.lastEquipment = snapshot.equipment; runtime.lastEffects = this.state.effects.map(effect => ({ ...effect })); runtime.lastHealth = health; runtime.lastHunger = this.state.hunger; runtime.lastSaturation = this.state.saturation; runtime.lastXp = this.state.totalXp; runtime.lastSelectedSlot = this.state.selectedSlot; } this.state.initialized = true; this.commit(); this.message(player, "Shared state initialized from you. Other eligible players will receive this state."); }
  private applyOrInitialize(player: Player): void { if (!this.state.initialized) this.initializeFrom(player); else this.apply(player); }
  private reconcile(): void { this.tick++; if (!this.state.enabled) return; this.advanceEffects(); this.passiveDeltas.healthRegen.clear(); this.passiveDeltas.hungerDrain.clear(); this.passiveDeltas.saturationDrain.clear(); for (const player of this.pool.activePlayers()) { const runtime = this.pool.runtime(player); if (!runtime) continue; runtime.lastSeenTick = this.tick; if (!this.state.initialized) { this.initializeFrom(player); continue; } if (!locked(runtime, this.tick) && runtime.phase === "applying") runtime.phase = "active"; if (!locked(runtime, this.tick) && runtime.phase === "active") this.observe(player); } if (this.replicationPending) { this.replicationPending = false; this.resync(); } }
  private observe(player: Player): void { const r = this.pool.runtime(player)!; const health = this.componentValue(player, EntityComponentTypes.Health); if (health !== undefined && r.lastHealth !== undefined && health !== r.lastHealth) { const delta = health - r.lastHealth; if (delta <= 0 || this.acceptPassiveDelta(this.passiveDeltas.healthRegen, delta)) { this.state.health = Math.max(0, this.state.health + delta); this.commit(); if (delta < 0) this.playDamageForClones(player); if (this.state.health <= 0 && this.config.shareDeath) this.beginDeath(player); } } const hunger = this.attribute(player, "minecraft:player.hunger"); if (hunger !== undefined && r.lastHunger !== undefined && hunger !== r.lastHunger) { const delta = hunger - r.lastHunger; if (delta >= 0 || this.acceptPassiveDelta(this.passiveDeltas.hungerDrain, delta)) { this.state.hunger = Math.max(0, Math.min(20, this.state.hunger + delta)); this.commit(); } } const saturation = this.attribute(player, "minecraft:player.saturation"); if (saturation !== undefined && r.lastSaturation !== undefined && saturation !== r.lastSaturation) { const delta = saturation - r.lastSaturation; if (delta >= 0 || this.acceptPassiveDelta(this.passiveDeltas.saturationDrain, delta)) { this.state.saturation = Math.max(0, Math.min(20, this.state.saturation + delta)); this.commit(); } } const xp = player.getTotalXp(); if (r.lastXp !== undefined && xp !== r.lastXp) { this.state.totalXp = Math.max(0, this.state.totalXp + xp - r.lastXp); this.commit(); } if (this.config.shareSelectedSlot && player.selectedSlotIndex !== r.lastSelectedSlot) { this.state.selectedSlot = player.selectedSlotIndex; this.commit(); } const current = capture(player); const inventoryChanged = !!r.lastInventory && this.inventoryChanged(r.lastInventory, current.inventory); if (inventoryChanged) { const result = resolveInventory(this.state.inventory, diffInventory(r.lastInventory!, current.inventory, player.id, this.tick)); if (result.accepted.length) { this.state.inventory = result.inventory; this.commit(); } if (result.rejected.length) { log("warn", "inventory", `Rejected ${result.rejected.length} conflicting inventory transaction(s) for ${player.name}`, this.tick, this.state.epoch); this.message(player, `Inventory conflict rejected ${result.rejected.length} change(s); your inventory was resynchronized.`); } } if (this.config.shareEquipment && r.lastEquipment && this.equipmentChanged(r.lastEquipment, current.equipment)) { if (inventoryChanged || this.isValidEquipmentWear(r.lastEquipment, current.equipment)) { this.state.equipment = current.equipment; this.commit(); } else { log("warn", "equipment", `Rejected an unsupported equipment mutation for ${player.name}`, this.tick, this.state.epoch); } } const effects = this.captureEffects(player); if (this.config.shareEffects && r.lastEffects && this.effectIntentChanged(r.lastEffects, effects)) { this.state.effects = effects; this.commit(); } this.refreshObservation(player); }
  private apply(player: Player): void { const r = this.pool.runtime(player); if (!r) return; acquire(r, this.tick, this.config.applyLockTicks, this.state.epoch); try { const health = player.getComponent(EntityComponentTypes.Health) as any; const currentHealth = this.componentValue(player, EntityComponentTypes.Health); const targetHealth = health ? Math.min(health.effectiveMax, Math.max(health.effectiveMin, this.state.health)) : undefined; if (this.config.shareHealth && health && currentHealth !== targetHealth) health.setCurrentValue(targetHealth); const hunger = this.attribute(player, "minecraft:player.hunger"); if (this.config.shareHunger && hunger !== this.state.hunger) this.setAttribute(player, "minecraft:player.hunger", this.state.hunger); const saturation = this.attribute(player, "minecraft:player.saturation"); if (this.config.shareHunger && saturation !== this.state.saturation) this.setAttribute(player, "minecraft:player.saturation", this.state.saturation); if (this.config.shareSelectedSlot && player.selectedSlotIndex !== this.state.selectedSlot) player.selectedSlotIndex = this.state.selectedSlot; if (this.config.shareExperience && player.getTotalXp() !== this.state.totalXp) { player.resetLevel(); if (this.state.totalXp > 0) player.addExperience(this.state.totalXp); } if (this.config.shareEffects) this.applyEffects(player); if (this.config.shareInventory || this.config.shareEquipment) write(player, { inventory: this.state.inventory, equipment: this.state.equipment }); const snapshot = capture(player); r.lastHealth = this.componentValue(player, EntityComponentTypes.Health); r.lastHunger = this.attribute(player, "minecraft:player.hunger"); r.lastSaturation = this.attribute(player, "minecraft:player.saturation"); r.lastXp = player.getTotalXp(); r.lastSelectedSlot = player.selectedSlotIndex; r.lastInventory = snapshot.inventory; r.lastEquipment = snapshot.equipment; r.lastEffects = this.captureEffects(player); } catch (error) { log("error", "coordinator", `Replica apply failed for ${player.name}: ${String(error)}`, this.tick, this.state.epoch); this.message(player, `CloneCraft error: apply failed for this player.`); } }
  private inventoryChanged(before: Array<any>, after: Array<any>): boolean { return before.some((item, index) => !exactEqual(item, after[index])); }
  private equipmentChanged(before: Record<string, any>, after: Record<string, any>): boolean { return Object.keys(before).some(key => !exactEqual(before[key], after[key])); }
  private isValidEquipmentWear(before: Record<string, any>, after: Record<string, any>): boolean { return Object.keys(before).every(key => exactEqual(before[key], after[key]) || (!!before[key] && (!after[key] || identityEqual(before[key], after[key])))); }
  beginDeath(source: Player): void {
    if (this.state.death.phase !== "alive") return;
    const participants = this.pool.activePlayers();
    if (!participants.some(player => player.id === source.id)) return;
    const dropper = participants.find(player => player.id === source.id) ?? participants[0];
    const keepInventory = this.keepInventory();
    const sharedSnapshot = { inventory: this.state.inventory, equipment: this.state.equipment };

    this.state.death = { phase: "killing", generation: this.state.death.generation + 1, expectedPlayerIds: participants.map(player => player.id), respawnedPlayerIds: [] };
    this.state.health = 0;
    this.state.totalXp = 0;
    this.state.effects = [];

    // A living dropper is first repaired from the authoritative state, so its
    // vanilla death produces the complete shared inventory exactly once.
    if (!keepInventory) {
      const dropperHealth = this.componentValue(dropper, EntityComponentTypes.Health);
      if (dropperHealth === undefined || dropperHealth > 0) write(dropper, sharedSnapshot);
      for (const player of participants) if (player.id !== dropper.id) this.clearReplicaBeforeDeath(player);
      this.state.inventory = Array(36).fill(undefined);
      this.state.equipment = { head: undefined, chest: undefined, legs: undefined, feet: undefined, offhand: undefined };
    }

    // XP is never retained by the shared state. Clearing it before clone kills
    // also prevents each replica from dropping the same XP a second time.
    for (const player of participants) this.clearExperienceBeforeDeath(player);
    this.commit();
    for (const player of participants) {
      try {
        this.pool.runtime(player)!.phase = "dead";
        player.kill();
      } catch (error) {
        log("error", "death", `Could not kill ${player.name}: ${String(error)}`);
      }
    }
    this.state.death.phase = "waiting_for_respawns";
    log("warn", "death", `Shared death generation ${this.state.death.generation} started from ${source.name}; ${dropper.name} is the only item drop source.`);
    this.message(source, "Shared death started; waiting for all clones to respawn.");
  }
  private keepInventory(): boolean { try { return world.gameRules.keepInventory; } catch { return false; } }
  private restoreAfterDeath(): void { if (this.state.death.phase !== "restoring") return; const players = world.getAllPlayers().filter(player => this.state.death.expectedPlayerIds.includes(player.id)); const healthMaxima = players.map(player => this.componentMaximum(player, EntityComponentTypes.Health)).filter((value): value is number => value !== undefined); this.state.health = Math.max(1, Math.min(...(healthMaxima.length ? healthMaxima : [20]))); this.state.hunger = 20; this.state.saturation = 5; this.state.death.phase = "alive"; this.commit(); for (const player of players) { const runtime = this.pool.runtime(player); if (runtime) runtime.phase = "pending_spawn"; this.apply(player); } log("info", "death", `Shared death generation ${this.state.death.generation} restored`); }
  private refreshObservation(player: Player): void { const runtime = this.pool.runtime(player); if (!runtime) return; const current = capture(player); runtime.lastHealth = this.componentValue(player, EntityComponentTypes.Health); runtime.lastHunger = this.attribute(player, "minecraft:player.hunger"); runtime.lastSaturation = this.attribute(player, "minecraft:player.saturation"); runtime.lastXp = player.getTotalXp(); runtime.lastSelectedSlot = player.selectedSlotIndex; runtime.lastInventory = current.inventory.map(item => item?.clone()); runtime.lastEquipment = current.equipment; runtime.lastEffects = this.captureEffects(player); }
  private message(player: Player, message: string): void { try { player.sendMessage(`§6[CloneCraft]§r ${message}`); } catch { /* player may be disconnecting */ } }
  private broadcast(message: string): void { for (const player of this.pool.activePlayers()) this.message(player, message); }
  private componentValue(player: Player, component: any): number | undefined { try { return (player.getComponent(component) as any)?.currentValue; } catch { return undefined; } }
  private attribute(player: Player, id: string): number | undefined { return this.componentValue(player, id); }
  private setAttribute(player: Player, id: string, value: number): void { try { (player.getComponent(id) as any)?.setCurrentValue(value); } catch { /* unsupported on this API build */ } }
  private clearReplicaBeforeDeath(player: Player): void { try { write(player, { inventory: Array(36).fill(undefined), equipment: { head: undefined, chest: undefined, legs: undefined, feet: undefined, offhand: undefined } }); } catch (error) { log("error", "death", `Could not clear duplicate drops for ${player.name}: ${String(error)}`); } }
  private clearExperienceBeforeDeath(player: Player): void { try { if (player.getTotalXp() !== 0) player.resetLevel(); } catch (error) { log("error", "death", `Could not clear XP for ${player.name}: ${String(error)}`); } }
  private captureEffects(player: Player): Array<{ typeId: string; amplifier: number; duration: number }> { try { return player.getEffects().filter(effect => effect.isValid && effect.duration > 0).map(effect => ({ typeId: effect.typeId, amplifier: effect.amplifier, duration: effect.duration })).sort((a, b) => a.typeId.localeCompare(b.typeId)); } catch { return []; } }
  private advanceEffects(): void { if (!this.config.shareEffects || this.state.effects.length === 0) return; const effects = this.state.effects.map(effect => ({ ...effect, duration: effect.duration - this.config.reconciliationIntervalTicks })).filter(effect => effect.duration > 0); if (effects.length !== this.state.effects.length) this.state.dirty = true; this.state.effects = effects; }
  private effectIntentChanged(before: Array<{ typeId: string; amplifier: number; duration: number }>, after: Array<{ typeId: string; amplifier: number; duration: number }>): boolean { const previous = new Map(before.map(effect => [effect.typeId, effect])); const current = new Map(after.map(effect => [effect.typeId, effect])); if (previous.size !== current.size) return true; for (const [typeId, effect] of current) { const earlier = previous.get(typeId); if (!earlier || earlier.amplifier !== effect.amplifier || effect.duration > earlier.duration + this.config.reconciliationIntervalTicks) return true; } return false; }
  private applyEffects(player: Player): void { const target = new Map(this.captureEffects(player).map(effect => [effect.typeId, effect])); const shared = new Map(this.state.effects.map(effect => [effect.typeId, effect])); for (const typeId of target.keys()) if (!shared.has(typeId)) player.removeEffect(typeId); for (const effect of this.state.effects) { const current = target.get(effect.typeId); if (!current || current.amplifier !== effect.amplifier || current.duration + this.config.applyLockTicks < effect.duration) player.addEffect(effect.typeId, effect.duration, { amplifier: effect.amplifier }); } }
  private componentMaximum(player: Player, component: any): number | undefined { try { return (player.getComponent(component) as any)?.effectiveMax; } catch { return undefined; } }
  private acceptPassiveDelta(seen: Set<number>, delta: number): boolean { if (seen.has(delta)) return false; seen.add(delta); return true; }
  private playDamageForClones(source: Player): void { for (const player of this.pool.activePlayers()) if (player.id !== source.id) { try { player.playSound("damage.hurt"); } catch { /* sound support varies by client */ } } }
  private commit(): void { this.state.epoch++; this.state.lastCommitTick = this.tick; this.state.dirty = true; this.replicationPending = true; const displayedHealth = Math.trunc(this.state.health); if (this.lastAnnouncedHealth !== displayedHealth) { this.lastAnnouncedHealth = displayedHealth; this.broadcast(`Shared health is now ${displayedHealth}.`); } }
}
