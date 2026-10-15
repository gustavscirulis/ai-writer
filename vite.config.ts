import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Icon Composer rewrites this file in its own JSON style on every save.
    ignorePatterns: ["**/*.icon/**"],
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
