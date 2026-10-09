/**
 * Declarations for `@simtlix/simfinity-core/plugins`. The default export is the root `plugins`
 * namespace, and every named export has the type of the same member, so the two cannot drift.
 */
import { plugins } from './index.js';

export type { AuthPluginOptions, EnvelopSchemaPlugin, PermissionSchema } from './index.js';
// The /auth declaration itself, as the runtime re-exports that binding, so the two subpaths can be
// re-exported together.
export { createAuthPlugin } from './auth/index.js';
export const apolloCountPlugin: typeof plugins.apolloCountPlugin;
export const envelopCountPlugin: typeof plugins.envelopCountPlugin;

export default plugins;
