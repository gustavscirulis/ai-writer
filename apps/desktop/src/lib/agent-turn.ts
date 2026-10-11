/** Synchronous handoff guard shared by save/store/editor/watcher boundaries. */
let locked = false;
let appClosing = false;
export function isAppClosing() {
  return appClosing;
}
export function setAppClosing(value: boolean) {
  appClosing = value;
}
let pathMutations = 0;
const mutationWaiters = new Set<() => void>();
export function waitForPathMutations() {
  return pathMutations === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => mutationWaiters.add(resolve));
}
export function isPathMutating() {
  return pathMutations > 0;
}
/** Relocation and an agent handoff acquire mutually exclusive synchronous ownership. */
export function beginPathMutation() {
  if (appClosing) throw new Error("Writer is saving feedback before closing.");
  if (locked) throw new Error("Wait for AI editing to finish before moving files.");
  pathMutations++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      pathMutations--;
      if (pathMutations === 0) {
        for (const resolve of mutationWaiters) resolve();
        mutationWaiters.clear();
      }
    }
  };
}
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
