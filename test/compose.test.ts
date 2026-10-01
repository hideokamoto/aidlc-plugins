// Every plugin must compose cleanly into every pinned core release: no
// validation errors, no dropped contributions, and an idempotent re-run. A
// dropped contribution means a core update moved a heading this repository's
// prose anchors to, and the prose silently vanished from the stage.
import { describe, expect, it } from "vitest";
import { discoverPlugins } from "../scripts/lib/plugins.ts";
import { pinnedVersions } from "../scripts/lib/runtime.ts";
import { compose } from "./support/core.ts";

const cases = pinnedVersions().flatMap((version) =>
  discoverPlugins().map((plugin) => ({ version, plugin })),
);

describe.each(cases)("$plugin.key on aidlc $version", ({ version, plugin }) => {
  it("composes with no errors, no drops, and idempotently", () => {
    const { result } = compose(version, plugin.dir);
    expect(result.errors).toEqual([]);
    expect(result.drops).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.idempotent).toBe(true);
  });
});
