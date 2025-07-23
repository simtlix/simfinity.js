import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [
    {
        ignores: ["node_modules/*", "data/*", "eslint.config.mjs"],
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.es2024,
            },
            ecmaVersion: 2024,
            sourceType: "module",
        },
        rules: {
            // Code style and best practices (relaxed to match existing code)
            "quotes": ["error", "single"],
            "semi": ["error", "always"],
            "comma-dangle": ["error", "always-multiline"],
            "object-curly-spacing": ["error", "always"],
            "array-bracket-spacing": ["error", "never"],
            
            // ES6+ features
            "prefer-const": "error",
            "no-var": "error",
            "prefer-arrow-callback": "off", // Allow function declarations
            "arrow-spacing": "error",
            
            // Best practices
            "no-console": "off", // Allow console for this project
            "no-underscore-dangle": "off", // Allow underscore dangle for MongoDB _id
            "no-await-in-loop": "off",
            "max-len": "off", // Disable max-len for now
            "indent": "off", // Disable indent for now to match existing style
            
            // Parameter reassignment (common in GraphQL resolvers)
            "no-param-reassign": ["error", { "props": false }],
            
            // Function formatting
            "function-paren-newline": "off",
            "function-call-argument-newline": "off",
            
            // Restricted syntax
            "no-restricted-syntax": ["error", {
                selector: "ForInStatement",
                message: "for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.",
            }, {
                selector: "LabeledStatement", 
                message: "Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.",
            }, {
                selector: "WithStatement",
                message: "`with` is disallowed in strict mode because it makes code impossible to predict and optimize.",
            }],
        },
    },
];