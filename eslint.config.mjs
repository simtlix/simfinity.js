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
    ...compat.extends("airbnb-base"),
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.commonjs,
                ...globals.node,
                ...globals.jest,
            },

            ecmaVersion: 2024,
            sourceType: "commonjs",
        },

        rules: {
            "default-case": "off",
            "max-len": 0,
            "no-console": "off",
            "no-underscore-dangle": "off",
            "no-await-in-loop": "off",

            "no-param-reassign": ["error", {
                props: false,
            }],

            "function-paren-newline": "off",
            "function-call-argument-newline": "off",

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

            "import/no-unresolved": ["error", {
                ignore: ["graphql", "mongoose"],
            }],
        },
    },
];