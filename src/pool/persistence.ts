import { world } from "@minecraft/server";
import { SharedState } from "../model/types";
import { log } from "../utilities/logging";

const KEY = "clonecraft:state";
export class Persistence {
  load(): SharedState | undefined { try { const raw = world.getDynamicProperty(KEY); if (typeof raw !== "string") return undefined; const parsed = JSON.parse(raw) as SharedState; if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.inventory) || parsed.inventory.length !== 36) return undefined; return parsed; } catch (error) { log("error", "persistence", `Ignoring invalid saved state: ${String(error)}`); return undefined; } }
  save(state: SharedState): void { try { world.setDynamicProperty(KEY, JSON.stringify({ ...state, inventory: Array(36).fill(undefined), equipment: {} })); } catch (error) { log("error", "persistence", `Save failed: ${String(error)}`); } }
}
