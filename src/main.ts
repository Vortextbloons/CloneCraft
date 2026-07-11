import { PlayerPermissionLevel, system, world } from "@minecraft/server";
import { DEFAULT_CONFIG, validateConfig } from "./config";
import { Coordinator } from "./sync/coordinator";
import { PlayerPool } from "./pool/playerPool";
import { log } from "./utilities/logging";

validateConfig(DEFAULT_CONFIG);
const pool = new PlayerPool(DEFAULT_CONFIG);
const coordinator = new Coordinator(DEFAULT_CONFIG, pool);

world.afterEvents.playerJoin.subscribe(event => {
  const player = world.getAllPlayers().find(candidate => candidate.id === event.playerId);
  if (player) coordinator.admit(player);
});
world.afterEvents.playerSpawn.subscribe(event => {
  if (event.initialSpawn) coordinator.admit(event.player);
  else coordinator.markRespawn(event.player);
});
world.afterEvents.entityDie.subscribe(event => {
  const player = event.deadEntity.typeId === "minecraft:player" ? event.deadEntity : undefined;
  if (player) coordinator.beginDeath(player as any);
});
world.afterEvents.playerGameModeChange.subscribe(event => {
  if (!pool.eligible(event.player)) pool.leave(event.player.id);
});
world.beforeEvents.playerLeave.subscribe(event => coordinator.remove(event.player.id));

system.afterEvents.scriptEventReceive.subscribe(event => {
  if (!event.id.startsWith("clonecraft:")) return;
  const command = event.id.slice("clonecraft:".length);
  const source = event.sourceEntity;
  const sourcePlayer = source?.typeId === "minecraft:player" ? source as any : undefined;
  if (sourcePlayer && sourcePlayer.playerPermissionLevel < PlayerPermissionLevel.Operator) { sourcePlayer.sendMessage("CloneCraft: operator permission required."); return; }
  const args = event.message.trim().split(/\s+/).filter(Boolean);
  switch (command) {
    case "enable": coordinator.setEnabled(true); break;
    case "disable": coordinator.setEnabled(false); break;
    case "resync": coordinator.resync(); break;
    case "status": { const state = coordinator.snapshot; const message = `${pool.status()} initialized=${state.initialized} enabled=${state.enabled} epoch=${state.epoch} phase=${state.death.phase} dirty=${state.dirty}`; log("info", "admin", message); sourcePlayer?.sendMessage(`CloneCraft: ${message}`); break; }
    case "save": coordinator.saveNow(); sourcePlayer?.sendMessage("CloneCraft: state saved."); break;
    case "reset": { const player = world.getAllPlayers().filter(candidate => pool.eligible(candidate)).sort((a, b) => a.id.localeCompare(b.id))[0]; if (!player) { sourcePlayer?.sendMessage("CloneCraft: reset requires an active player."); break; } coordinator.resetFrom(player); sourcePlayer?.sendMessage(`CloneCraft: reset from ${player.name}.`); break; }
    case "set_health": { const value = Number(args[0]); if (!Number.isFinite(value) || value < 0 || value > 1024) { sourcePlayer?.sendMessage("CloneCraft: health must be 0..1024."); break; } coordinator.setHealth(value); sourcePlayer?.sendMessage(`CloneCraft: shared health set to ${value}.`); break; }
    default: log("warn", "admin", `Unknown command: ${command}`);
  }
});

function boot(): void {
  if (coordinator.isStarted()) return;
  coordinator.start();
  for (const player of world.getAllPlayers()) coordinator.admit(player);
  world.sendMessage("§a[CloneCraft] §fScript loaded successfully!");
  log("info", "main", "CloneCraft foundation loaded");
}

// worldLoad can still be in early execution on some Bedrock builds. Queue an
// extra tick before reading players or dynamic properties.
world.afterEvents.worldLoad.subscribe(() => system.run(boot));
system.run(() => system.run(boot));
