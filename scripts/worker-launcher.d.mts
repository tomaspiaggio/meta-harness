export interface ReleaseState {
  current: string;
  previous?: string;
  pending?: { target: string; from: string; failures: number; at: number };
  lastFailure?: { target: string; at: number; reason: string };
}
export const RESTART: number;
export const CONFIRM_MS: number;
export function readState(root: string): ReleaseState;
export function writeState(root: string, state: ReleaseState): void;
export function afterExit(
  state: ReleaseState,
  exit: { code: number | null; timedOut?: boolean; now?: number },
): ReleaseState;
export function switchRelease(root: string, name: string, now?: number): void;
export function confirmRelease(root: string, name: string): boolean;
export function prepareRelease(
  root: string,
  target: string,
  options?: { install?: string[]; branch?: string },
): Promise<string>;
export function installRoot(
  root: string,
  target: string,
  options?: { install?: string[]; branch?: string; origin?: string },
): Promise<string>;
