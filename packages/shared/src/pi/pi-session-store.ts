import { PI_SESSIONS_DIR } from '../config/paths.ts';
import {
  readTreeSessionHeader,
  readTreeSessionMetadata,
  readTreeSessionJsonl,
  type TreeSessionHeader,
} from '../sessions/tree-jsonl.ts';

export class PiSessionStore {
  constructor(readonly sessionRoot = PI_SESSIONS_DIR) {}

  readHeader(sessionFile: string): TreeSessionHeader | null {
    return readTreeSessionHeader(sessionFile);
  }

  readMetadata(sessionFile: string, workspaceRootPath?: string) {
    return readTreeSessionMetadata(sessionFile, workspaceRootPath);
  }

  readTree(sessionFile: string) {
    return readTreeSessionJsonl(sessionFile);
  }
}

export function createPiSessionStore(sessionRoot?: string): PiSessionStore {
  return new PiSessionStore(sessionRoot);
}
