import { PlayerRuntime } from "../model/types";
export function locked(runtime: PlayerRuntime, tick: number): boolean { return runtime.lockUntilTick > tick; }
export function acquire(runtime: PlayerRuntime, tick: number, duration: number, epoch: number): void { runtime.phase = "applying"; runtime.lockUntilTick = tick + duration; runtime.appliedEpoch = epoch; }
