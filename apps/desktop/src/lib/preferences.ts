import { load } from "@tauri-apps/plugin-store";

const PREFERENCES = "preferences.json";
const stores = new Map<string, ReturnType<typeof load>>();

function getStore(file = PREFERENCES) {
  let store = stores.get(file);
  if (!store) {
    store = load(file, {
      defaults: {},
      autoSave: true,
    });
    stores.set(file, store);
  }
  return store;
}

export async function getPreference<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = await getStore();
    const value = await store.get<T>(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setPreference<T>(key: string, value: T): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch {
    // Silently fail in non-Tauri environments (tests)
  }
}

/** Durable boundaries for user-authored data: callers own error recovery. */
export async function readPreferenceStrict<T>(key: string): Promise<T | undefined> {
  return (await getStore()).get<T>(key);
}

export async function writePreferenceStrict<T>(key: string, value: T): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
}

export async function readStoreEntriesStrict<T>(file: string): Promise<[string, T][]> {
  return (await getStore(file)).entries<T>();
}

/** Applies every change before one save; `undefined` deletes the key. */
export async function writeStoreEntriesStrict<T>(
  file: string,
  changes: [string, T | undefined][],
): Promise<void> {
  const store = await getStore(file);
  for (const [key, value] of changes) {
    if (value === undefined) await store.delete(key);
    else await store.set(key, value);
  }
  await store.save();
}
