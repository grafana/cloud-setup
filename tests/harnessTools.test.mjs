import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { fileTools } = await import("../dist/harness/tools.js");

function toolByName(cwd, name) {
  return fileTools(cwd).find((t) => t.name === name);
}

test("list_dir returns a non-empty placeholder for an empty directory", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cloud-setup-tools-"));
  try {
    mkdirSync(path.join(cwd, "src/components"), { recursive: true });

    const result = toolByName(cwd, "list_dir").execute({ path: "src/components" });

    assert.equal(result, "(empty directory)");
    assert.notEqual(result, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("list_dir still lists entries normally when the directory has content", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cloud-setup-tools-"));
  try {
    mkdirSync(path.join(cwd, "src/components"), { recursive: true });
    writeFileSync(path.join(cwd, "src/components/frontend-observability.tsx"), "// stub", "utf8");

    const result = toolByName(cwd, "list_dir").execute({ path: "src/components" });

    assert.equal(result, "frontend-observability.tsx");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
