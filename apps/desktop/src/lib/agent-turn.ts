/** Synchronous handoff guard shared by save/store/editor/watcher boundaries. */
const identities = new Map<string, string>();
let identityGeneration = 0;
export function documentIdentityGeneration() {
  return identityGeneration;
}
export function clearDocumentPaths() {
  identityGeneration++;
  identities.clear();
}
/** Display paths remain stable; every I/O boundary uses the native resolved path. */
export function documentPath(path: string) {
  return identities.get(path) ?? path;
}
export function registerDocumentPath(path: string, canonical: string) {
  identities.set(path, canonical);
}
export function rewriteDocumentPaths(
  from: string,
  to: string,
  directory: boolean,
  source: string,
  destination: string,
) {
  const move = (path: string, old: string, next: string) =>
    path === old
      ? next
      : directory && path.startsWith(`${old}/`)
        ? next + path.slice(old.length)
        : path;
  const entries = Array.from(identities);
  identities.clear();
  for (const [path, canonical] of entries)
    identities.set(move(path, from, to), move(canonical, source, destination));
  registerDocumentPath(to, destination);
}
let resets = 0;
export function reserveAgentReset() {
  resets++;
  return () => {
    resets--;
  };
}
const locks = new Map<string, symbol>();
const turns = new Map<string, Set<symbol>>();
const revisions = new Map<string, number>();
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
  if (isAgentTurnActive()) throw new Error("Wait for the AI to finish before moving files.");
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
const flushers = new Map<() => void, () => string>();
export function registerPendingEditorFlush(path: () => string, flush: () => void) {
  flushers.set(flush, path);
  return () => {
    flushers.delete(flush);
  };
}
const listeners = new Set<() => void>();
const reloads = new Map<string, { version: number; frontmatter: string | null }>();
export function isAgentEditing(path?: string) {
  return path === undefined ? locks.size > 0 || resets > 0 : locks.has(documentPath(path));
}
/** A turn spans thinking and tools; the note is locked only while an edit is applied. */
export function isAgentTurnActive(path?: string) {
  if (path === undefined) return turns.size > 0 || isAgentEditing();
  const key = documentPath(path);
  return turns.has(key) || locks.has(key);
}
export function acquireAgentTurn(path: string) {
  const key = documentPath(path);
  const owner = Symbol(key);
  const owners = turns.get(key) ?? new Set();
  turns.set(key, owners.add(owner));
  return () => {
    const current = turns.get(key);
    if (current?.delete(owner) && !current.size) turns.delete(key);
  };
}
export function agentIORevision(path?: string) {
  return path === undefined ? revision : (revisions.get(documentPath(path)) ?? 0);
}
function changed(path: string) {
  revision++;
  revisions.set(path, (revisions.get(path) ?? 0) + 1);
  for (const listener of listeners) listener();
}
export function flushPendingEditors(path: string) {
  const key = documentPath(path);
  for (const [flush, binding] of Array.from(flushers)) if (documentPath(binding()) === key) flush();
}
/** Flush embedded edits before acquiring synchronous, token-owned handoff. */
export function acquireAgentEditing(path: string) {
  const key = documentPath(path);
  if (locks.has(key)) throw new Error("An agent is already editing this note.");
  flushPendingEditors(path);
  const owner = Symbol(key);
  locks.set(key, owner);
  changed(key);
  return () => {
    if (locks.get(key) !== owner) return;
    locks.delete(key);
    changed(key);
  };
}
export function clearAgentEditing() {
  turns.clear();
  for (const path of locks.keys()) {
    locks.delete(path);
    changed(path);
  }
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
