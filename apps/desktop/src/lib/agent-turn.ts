/** Synchronous handoff guard shared by save/store/editor/watcher boundaries. */
let locked = false;
let revision = 0;
const flushers = new Set<() => void>();
export function registerPendingEditorFlush(flush: () => void) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
const listeners = new Set<() => void>();
const reloads = new Map<string, { version: number; frontmatter: string | null }>();

export function isAgentEditing() {
  return locked;
}
export function agentIORevision() {
  return revision;
}
export function setAgentEditing(value: boolean) {
  if (locked === value) return;
  if (value) {
    const pending = Array.from(flushers);
    for (const flush of pending) flush();
  }
  locked = value;
  revision++;
  for (const listener of listeners) listener();
}
export function subscribeAgentEditing(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function markAgentReload(path: string, version: number, frontmatter: string | null) {
  reloads.set(path, { version, frontmatter });
}
export function getAgentReload(path: string, version: number) {
  const reload = reloads.get(path);
  return reload?.version === version ? reload : null;
}
export function consumeAgentReload(path: string, version: number) {
  const reload = reloads.get(path);
  reloads.delete(path);
  return reload?.version === version ? reload : null;
}
