/** Opaque native transcripts; provider credentials never belong in this store. */
export interface NativeSessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}
export interface NativeSessionEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
}
export interface NativeSessionStore {
  append(key: NativeSessionKey, entries: NativeSessionEntry[]): Promise<void>;
  load(key: NativeSessionKey): Promise<NativeSessionEntry[] | null>;
  listSubkeys?(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]>;
}
