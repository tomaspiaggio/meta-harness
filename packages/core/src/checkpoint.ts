export interface FileSnapshot {
  version: 1;
  files: { path: string; data: string; sha256: string; executable: boolean }[];
}

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  turnId: string;
  nativeId: string | null;
  nativeRevision?: number;
  snapshot: FileSnapshot;
  createdAt: number;
}
