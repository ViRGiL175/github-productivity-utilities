export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Target {

  owner: string;
  number: number;
}

export interface ProjectSnapshot {

  target: Target;
  project: { id: string; [key: string]: Json };
  items: Array<{ id: string; [key: string]: Json }>;
  startedAt: Date;
  observedAt: Date;
  complete: true;
  expectedCount: number;
}

export interface SnapshotReader {

  read(target: Target): Promise<ProjectSnapshot>;
}
