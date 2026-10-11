import { load } from "@tauri-apps/plugin-store";

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load("preferences.json", {
      defaults: {},
      autoSave: true,
    });
  }
  return storePromise;
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
