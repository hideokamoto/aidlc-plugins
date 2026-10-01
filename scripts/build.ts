// Build every plugin into <plugin>/dist/claude and write the marketplace
// catalogue. Outputs are git-ignored on main; CD commits them to `release`.
import { buildPlugin, distDir, writeCatalog } from "./lib/build.ts";
import { discoverPlugins } from "./lib/plugins.ts";
import { buildVersion, fetchRuntime } from "./lib/runtime.ts";

const version = buildVersion();
fetchRuntime(version);
const plugins = discoverPlugins();
for (const plugin of plugins) {
  buildPlugin(version, plugin);
  console.log(`${plugin.hostName} ${plugin.manifest.version} -> ${distDir(plugin)}`);
}
console.log(`catalogue -> ${writeCatalog(plugins)}`);
