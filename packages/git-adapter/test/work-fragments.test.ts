import assert from "node:assert/strict";
import test from "node:test";
import { workFragmentsFromPatch } from "../src/index.js";

test("no-hunk binary, mode, rename, and empty-file changes become stable file Work Fragments", () => {
  const fixtures = [
    {
      name: "binary",
      path: "assets/logo.png",
      patch: "diff --git a/assets/logo.png b/assets/logo.png\nindex 1111111..2222222 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n",
    },
    {
      name: "mode",
      path: "scripts/run.sh",
      patch: "diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\nnew mode 100755\n",
    },
    {
      name: "rename",
      path: "src/new-name.ts",
      patch: "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n",
    },
    {
      name: "empty file",
      path: "src/empty.ts",
      patch: "diff --git a/src/empty.ts b/src/empty.ts\nnew file mode 100644\nindex 0000000..e69de29\n",
    },
  ];

  for (const fixture of fixtures) {
    const first = workFragmentsFromPatch(fixture.patch);
    assert.equal(first.length, 1, fixture.name);
    assert.equal(first[0]?.path, fixture.path, fixture.name);
    assert.equal(first[0]?.oldLines, 0, fixture.name);
    assert.equal(first[0]?.newLines, 0, fixture.name);
    assert.equal(first[0]?.patch, fixture.patch, fixture.name);
    assert.deepEqual(first, workFragmentsFromPatch(fixture.patch), `${fixture.name} stability`);
  }
});
