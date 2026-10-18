import type { Change, Settings, Snapshot } from "../../core/types";

export interface Repository {
  readonly refreshSchedules?: boolean;
  load(): Promise<Snapshot>;
  commit(changes: Change[], settings: Settings | null): Promise<void>;
  changes(): Promise<Change[]>;
}
