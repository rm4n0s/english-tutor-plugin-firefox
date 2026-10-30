import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const bannedProperties = ["innerHTML", "outerHTML", "insertAdjacentHTML"].map((property) => ({
  property,
  message: `Do not use ${property}: build DOM with createElement and textContent.`,
}));

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "web-ext-artifacts/", "docs/"] },
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts", "vitest.config.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-properties": ["error", ...bannedProperties],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
          message: "Do not use document.write.",
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: "Do not use new Function.",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // Tests may build values the types forbid, on purpose.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
