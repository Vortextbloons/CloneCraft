export type LogLevel = "error" | "warn" | "info" | "debug";
export function log(level: LogLevel, subsystem: string, message: string, tick = -1, epoch = -1): void { const line = `[CloneCraft][${level}][${subsystem}][t=${tick}][e=${epoch}] ${message}`; if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line); }
