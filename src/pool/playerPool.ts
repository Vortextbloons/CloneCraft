import { GameMode, Player, world } from "@minecraft/server";
import { CloneCraftConfig } from "../config";
import { PlayerRuntime } from "../model/types";
import { log } from "../utilities/logging";

export class PlayerPool {
  readonly players = new Map<string, PlayerRuntime>();
  constructor(private readonly config: CloneCraftConfig) {}
  eligible(player: Player): boolean { const mode = player.getGameMode(); return !(this.config.excludeCreative && mode === GameMode.Creative) && !(this.config.excludeSpectator && mode === GameMode.Spectator); }
  join(player: Player, tick: number): PlayerRuntime | undefined { if (!this.eligible(player)) return undefined; const runtime = this.players.get(player.id) ?? { id: player.id, name: player.name, phase: "pending_spawn", appliedEpoch: 0, lockUntilTick: 0, joinedTick: tick, lastSeenTick: tick }; runtime.lastSeenTick = tick; runtime.name = player.name; this.players.set(player.id, runtime); return runtime; }
  leave(id: string): void { this.players.delete(id); }
  activePlayers(): Player[] { return world.getAllPlayers().filter(p => { const r = this.players.get(p.id); return r?.phase === "active" && this.eligible(p); }).sort((a, b) => a.id.localeCompare(b.id)); }
  runtime(player: Player): PlayerRuntime | undefined { return this.players.get(player.id); }
  status(): string { return `pool=${this.players.size} active=${[...this.players.values()].filter(p => p.phase === "active").length}`; }
}
