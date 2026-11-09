import { config } from '../config.js';
import { CoolifyEngine } from './coolify.js';
import type { Engine } from './types.js';

export type { Engine, BuildPack, CreateAppInput, DeployResult, UpdateAppInput } from './types.js';

let current: Engine | null = null;

/** The configured engine (ENGINE=coolify). Tests can replace it with setEngine. */
export function engine(): Engine {
  if (current) return current;
  switch (config.engine.type) {
    case 'coolify': current = new CoolifyEngine(); break;
    default: throw new Error(`Unknown ENGINE "${config.engine.type}"`);
  }
  return current;
}

export function setEngine(e: Engine | null): void {
  current = e;
}
