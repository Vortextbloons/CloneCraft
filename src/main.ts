import { system, world } from "@minecraft/server";
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
world.afterEvents.playerGameModeChange.subscribe(event => {
  if (!pool.eligible(event.player)) pool.leave(event.player.id);
});
world.beforeEvents.playerLeave.subscribe(event => coordinator.remove(event.player.id));

system.afterEvents.scriptEventReceive.subscribe(event => {
  if (!event.id.startsWith("clonecraft:")) return;
  const command = event.id.slice("clonecraft:".length);
  const source = event.sourceEntity;
  const sourcePlayer = source?.typeId === "minecraft:player" ? source : undefined;
  if (sourcePlayer && !pool.runtime(sourcePlayer as any)) return;
  switch (command) {
    case "enable": coordinator.setEnabled(true); break;
    case "disable": coordinator.setEnabled(false); break;
    case "resync": coordinator.resync(); break;
    case "status": log("info", "admin", `${pool.status()} initialized=${coordinator.snapshot.initialized} epoch=${coordinator.snapshot.epoch}`); break;
    case "save": log("info", "admin", "State will be saved at the next persistence checkpoint."); break;
    default: log("warn", "admin", `Unknown command: ${command}`);
  }
});

coordinator.start();
for (const player of world.getAllPlayers()) coordinator.admit(player);
log("info", "main", "CloneCraft foundation loaded");
