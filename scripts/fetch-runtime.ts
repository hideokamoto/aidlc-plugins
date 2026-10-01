// Download every pinned AI-DLC runtime into .aidlc-cache/.
import { fetchRuntime, pinnedVersions } from "./lib/runtime.ts";

for (const version of pinnedVersions()) {
  console.log(`aidlc ${version}: ${fetchRuntime(version)}`);
}
