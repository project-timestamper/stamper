import { defineConfig } from "eslint/config";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default defineConfig(
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      curly: ["error", "all"],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/indent": ["error", 2],
    },
  },
  {
    ignores: ["node_modules/**"],
  }
);
