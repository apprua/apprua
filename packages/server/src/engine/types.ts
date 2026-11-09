// The engine runs the apps (build, containers, routing). Apprua talks to it only through this interface,
// so another engine (e.g. a light one without Coolify) can be added by writing a second driver.

export type BuildPack = 'dockerfile' | 'static' | 'nixpacks' | 'railpack';

export interface CreateAppInput {
  name: string;
  description: string;
  /** Read-only git URL of the app's code (served by Apprua's built-in archive). */
  gitUrl: string;
  buildPack: BuildPack;
  port: number;
  /** Full public URL of the app, e.g. http://notes.localhost */
  url: string;
  cpus: string;
  memory: string;
}

export interface UpdateAppInput {
  description?: string;
  buildPack?: BuildPack;
  port?: number;
  cpus?: string;
  memory?: string;
}

export interface DeployResult {
  status: 'finished' | 'failed' | 'timeout';
  logTail: string[];
}

export interface Engine {
  readonly name: string;
  /** Checks that the engine answers and the credentials work; returns a short description. */
  check(): Promise<string>;
  createApp(i: CreateAppInput): Promise<string>;
  updateApp(id: string, i: UpdateAppInput): Promise<void>;
  deleteApp(id: string): Promise<void>;
  /** Moves the app to a new public address (e.g. from http://notes.localhost to the local network). */
  setUrl(id: string, url: string): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  /** Keeps /data across restarts and new versions. */
  addPersistentStorage(id: string, volumeName: string): Promise<void>;
  /** Labels for owner/app and, when configured, the login in front of the app. */
  applyLabels(id: string, appName: string, owner: string): Promise<void>;
  setEnv(id: string, key: string, value: string): Promise<void>;
  /** Names of the environment variables / secrets of the app (never the values). */
  listEnv(id: string): Promise<string[]>;
  deleteEnv(id: string, key: string): Promise<void>;
  runtimeStatus(id: string): Promise<string | null>;
  runtimeLogs(id: string, lines: number): Promise<string[]>;
  /** Starts a build + deploy of the latest code; returns the deployment id. */
  deploy(id: string): Promise<string>;
  /** Follows a deployment until it ends or the timeout expires (timeout 0 = read once). */
  waitDeployment(deploymentId: string, timeoutMs: number): Promise<DeployResult>;
  /** A deployment of the app created since that time and not among the known ones (its id), or null if there is none.
   *  Throws when the engine does not answer. Used when the answer to deploy() was lost. */
  findDeployment?(id: string, sinceIso: string, known: string[]): Promise<string | null>;
}
