export interface Debuggee { tabId?: number; targetId?: string }
export interface DebuggerSession extends Debuggee { sessionId?: string }
export interface Tab { id?: number; url?: string; title?: string; windowId?: number }
export function logUnhandledError() {
  console.error("A browser relay event could not be delivered.");
}
