import { world } from "@minecraft/server";
import { SharedState } from "../model/types";
import { log } from "../utilities/logging";
import { decode, encode } from "../inventory/itemCodec";

const META = "clonecraft:meta";
const CHUNK_PREFIX = "clonecraft:state_chunk_";
const CHECKSUM = "clonecraft:state_checksum";
const CHUNK_SIZE = 24000;
function checksum(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16); }
export class Persistence {
  load(): SharedState | undefined { try { const metaRaw = world.getDynamicProperty(META); if (typeof metaRaw !== "string") return undefined; const meta = JSON.parse(metaRaw) as { schemaVersion: number; chunks: number; checksum: string }; if (meta.schemaVersion !== 1 || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 128) return undefined; const raw = Array.from({ length: meta.chunks }, (_, index) => world.getDynamicProperty(`${CHUNK_PREFIX}${index}`)).join(""); if (checksum(raw) !== meta.checksum || world.getDynamicProperty(CHECKSUM) !== meta.checksum) return undefined; const parsed = JSON.parse(raw) as any; if (!Array.isArray(parsed.inventory) || parsed.inventory.length !== 36) return undefined; parsed.inventory = parsed.inventory.map(decode); parsed.equipment = Object.fromEntries(Object.entries(parsed.equipment ?? {}).map(([key, value]) => [key, decode(value as any)])); parsed.effects = Array.isArray(parsed.effects) ? parsed.effects.filter((effect: any) => typeof effect?.typeId === "string" && Number.isInteger(effect.amplifier) && Number.isInteger(effect.duration) && effect.duration > 0).map((effect: any) => ({ typeId: effect.typeId, amplifier: effect.amplifier, duration: effect.duration })) : []; return parsed as SharedState; } catch (error) { log("error", "persistence", `Ignoring invalid saved state: ${String(error)}`); return undefined; } }
  save(state: SharedState): void { try { const raw = JSON.stringify({ ...state, inventory: state.inventory.map(encode), equipment: Object.fromEntries(Object.entries(state.equipment).map(([key, value]) => [key, encode(value)])) }); const count = Math.ceil(raw.length / CHUNK_SIZE); if (count > 128) throw new Error("serialized state exceeds dynamic-property limits"); const digest = checksum(raw); for (let index = 0; index < count; index++) world.setDynamicProperty(`${CHUNK_PREFIX}${index}`, raw.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)); world.setDynamicProperty(CHECKSUM, digest); world.setDynamicProperty(META, JSON.stringify({ schemaVersion: 1, chunks: count, checksum: digest, savedAt: Date.now() })); } catch (error) { log("error", "persistence", `Save failed: ${String(error)}`); } }
}
