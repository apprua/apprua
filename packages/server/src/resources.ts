// Resources of the machine Apprua runs on (the Linux of the Windows installer, or a server):
// memory and disk, and an honest estimate of how many apps fit.
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { config } from './config.js';
import { getDb } from './db.js';

/** Memory kept aside for Coolify, its database, the proxy and Apprua itself. */
export const RESERVED_MB = 2048;
/** Disk space one app takes, with its image and build cache (a cautious average). */
export const DISK_PER_APP_MB = 1024;

export interface Resources {
  memTotalMb: number;
  memUsedMb: number;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
  /** RAM of the whole PC, when the Windows installer passed it. */
  hostMemoryGb: number | null;
  /** Running inside WSL (the Windows installer): memory can be raised from Windows. */
  wsl: boolean;
  appsOn: number;
  appsPaused: number;
  /** Memory limit given to each new app, in MB. */
  perAppMb: number;
  /** Apps that can be on together if each one used all its memory (cautious). */
  fitOn: number;
  /** New apps that fit in the free disk space. */
  fitNew: number | null;
}

export function memoryMb(m: string): number {
  const r = /^(\d+)\s*([mg])$/i.exec(m.trim());
  return r ? Number(r[1]) * (r[2].toLowerCase() === 'g' ? 1024 : 1) : 0;
}

/** The pure part: what fits, from the numbers measured. */
export function estimate(memTotalMb: number, perAppMb: number, diskFreeMb: number | null) {
  return {
    fitOn: perAppMb > 0 ? Math.max(0, Math.floor((memTotalMb - RESERVED_MB) / perAppMb)) : 0,
    fitNew: diskFreeMb === null ? null : Math.max(0, Math.floor(diskFreeMb / DISK_PER_APP_MB)),
  };
}

function meminfo(): { total: number; available: number } {
  try {
    const txt = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt)?.[1] ?? NaN);
    const total = kb('MemTotal'), available = kb('MemAvailable');
    if (Number.isFinite(total) && Number.isFinite(available)) return { total: total / 1024, available: available / 1024 };
  } catch { /* not Linux: fall back below */ }
  return { total: totalmem() / 1048576, available: freemem() / 1048576 };
}

function isWsl(): boolean {
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

export async function readResources(): Promise<Resources> {
  const mem = meminfo();
  let diskTotalMb: number | null = null, diskFreeMb: number | null = null;
  try {
    const s = await statfs(config.dataDir).catch(() => statfs('/'));
    diskTotalMb = (s.blocks * s.bsize) / 1048576;
    diskFreeMb = (s.bavail * s.bsize) / 1048576;
  } catch { /* unknown */ }
  // On Windows the Linux disk is a file that can grow up to 1 TB: the real limit is the free space of the
  // Windows drive that holds it. The installer mounts an empty folder of that drive (read-only) to measure it.
  const hostDisk = process.env.HOST_DISK_PATH;
  if (hostDisk) {
    try {
      const h = await statfs(hostDisk);
      const hFree = (h.bavail * h.bsize) / 1048576;
      diskTotalMb = (h.blocks * h.bsize) / 1048576;
      diskFreeMb = diskFreeMb === null ? hFree : Math.min(diskFreeMb, hFree);
    } catch { /* keep the Linux disk */ }
  }
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS n FROM apps WHERE status != 'archived' GROUP BY status`).all() as { status: string; n: number }[];
  const appsOn = rows.find((r) => r.status === 'active')?.n ?? 0;
  const appsPaused = rows.reduce((s, r) => s + r.n, 0) - appsOn;
  const perAppMb = memoryMb(config.policy.defaultMemory);
  const host = Number(process.env.HOST_MEMORY_GB);
  return {
    memTotalMb: mem.total, memUsedMb: Math.max(0, mem.total - mem.available),
    diskTotalMb, diskFreeMb,
    hostMemoryGb: Number.isFinite(host) && host > 0 ? host : null,
    wsl: isWsl(), appsOn, appsPaused, perAppMb,
    ...estimate(mem.total, perAppMb, diskFreeMb),
  };
}

/** The memory the apps that are on may use together (each one up to its limit), and the room there is for apps
 *  on this machine (its memory less the part kept for the platform). Shown when the memory of one app changes. */
export function appsMemory(totalMb = meminfo().total): { onMb: number; roomMb: number } {
  const rows = getDb().prepare(`SELECT memory FROM apps WHERE status = 'active'`).all() as { memory: string }[];
  return { onMb: rows.reduce((s, r) => s + memoryMb(r.memory), 0), roomMb: Math.max(0, totalMb - RESERVED_MB) };
}
