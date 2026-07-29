import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpdateManifest } from "./generate-update-manifest.mjs";

const base = {
  tag: "v0.1.0",
  version: "0.1.0",
  installerName: "PiDeck_0.1.0_x64-setup.exe",
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=\n",
  repo: "Skitre/PiDeck",
  publishedAt: "2026-07-29T00:00:00.000Z",
};

test("binds the windows updater entry to the tagged release asset", () => {
  const manifest = buildUpdateManifest(base);
  assert.deepEqual(manifest, {
    version: "0.1.0",
    pub_date: "2026-07-29T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
        url: "https://github.com/Skitre/PiDeck/releases/download/v0.1.0/PiDeck_0.1.0_x64-setup.exe",
      },
    },
  });
});

test("refuses a tag that disagrees with the packaged version", () => {
  assert.throws(
    () => buildUpdateManifest({ ...base, tag: "v0.2.0" }),
    /does not match the packaged app version/,
  );
});

test("refuses an empty updater signature", () => {
  assert.throws(() => buildUpdateManifest({ ...base, signature: "  " }), /signature is empty/);
});

test("refuses a non-installer asset and a malformed repo", () => {
  assert.throws(
    () => buildUpdateManifest({ ...base, installerName: "pideck.msi" }),
    /NSIS setup exe/,
  );
  assert.throws(
    () => buildUpdateManifest({ ...base, repo: "not-a-repo" }),
    /owner\/name/,
  );
});
