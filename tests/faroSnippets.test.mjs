import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { format } from "prettier";
import ts from "typescript";

mock.module("../dist/harness/index.js", {
  namedExports: {
    fileToolsWithWrite() {
      throw new Error("These fixtures must not invoke the Assistant");
    },
    runTask() {
      throw new Error("These fixtures must not invoke the Assistant");
    },
  },
});
const { insertFaroSnippet } = await import("../dist/products/frontendO11y/instrument.js");
const { instrumentReact } = await import("../dist/products/frontendO11y/react.js");

const options = {
  name: "test-app",
  collectorUrl: "https://collector.example.com/collect",
  version: "1.0.0",
  environmentExpr: "process.env.NODE_ENV",
  sessionPersistent: false,
  sessionReplay: false,
  replayMasking: "strict",
  samplingRate: 1,
};

for (const kind of ["javascript", "react"]) {
  function fixture(t, initial = "") {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "faro-snippet-test-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const file = kind === "react" ? "main.tsx" : "main.ts";
    const full = path.join(cwd, file);
    writeFileSync(full, initial);
    return {
      read: () => readFileSync(full, "utf8"),
      write: (source) => writeFileSync(full, source),
      async insert(config = options) {
        if (kind === "javascript") return insertFaroSnippet(cwd, { kind, file }, config);
        const result = await instrumentReact(cwd, "https://stack.grafana.net", file, config);
        assert.equal(result.complete, true);
      },
    };
  }

  test(`${kind}: insertion and unchanged reruns preserve application source`, async (t) => {
    const original = "// Application entry\nexport const App = () => null;\n";
    const file = fixture(t, original);
    await file.insert();
    const first = file.read();
    assert.ok(first.endsWith(original));
    assert.equal(first.match(/initializeFaro\(/g)?.length, 1);
    await file.insert();
    assert.equal(file.read(), first);
  });

  test(`${kind}: reruns preserve code and comments before and after the snippet`, async (t) => {
    const file = fixture(t);
    await file.insert();
    const prefix = '// Keep the license and this directive.\n"use client";\nconst before = () => "});";\n\n';
    const suffix = '\n// initializeFaro({ is only a comment.\nexport const after = "unchanged";\n';
    const original = prefix + file.read() + suffix;
    file.write(original);
    await file.insert();
    assert.equal(file.read(), original);
    await file.insert({ ...options, version: "2.0.0", samplingRate: 0.5, sessionPersistent: true });
    const updated = file.read();
    assert.ok(updated.startsWith(prefix));
    assert.ok(updated.endsWith(suffix));
    assert.match(updated, /version: '2\.0\.0'/);
    assert.match(updated, /samplingRate: 0\.5/);
    assert.match(updated, /persistent: true/);
    await file.insert({ ...options, version: "2.0.0", samplingRate: 0.5, sessionPersistent: true });
    assert.equal(file.read(), updated);
  });

  for (const endOfLine of ["lf", "crlf"]) {
    test(`${kind}: formatted ${endOfLine} snippets are updated without duplication`, async (t) => {
      const file = fixture(t, "export const App = () => null;\n");
      await file.insert({ ...options, sessionReplay: true });
      file.write(
        await format(file.read(), { parser: "typescript", singleQuote: false, semi: false, printWidth: 45, endOfLine }),
      );
      await file.insert({ ...options, version: "2.0.0", sessionReplay: false });
      const updated = file.read();
      assert.equal(updated.match(/initializeFaro\(/g)?.length, 1);
      assert.doesNotMatch(updated, /ReplayInstrumentation|faro-instrumentation-replay/);
      assert.match(updated, /version: '2\.0\.0'/);
      assert.match(updated, /export const App = \(\) => null/);
      if (endOfLine === "crlf") assert.doesNotMatch(updated, /(?<!\r)\n/);
      await file.insert({ ...options, version: "2.0.0", sessionReplay: false });
      assert.equal(file.read(), updated);
    });
  }

  test(`${kind}: replay can be enabled and disabled on later runs`, async (t) => {
    const file = fixture(t, "export const App = () => null;\n");
    await file.insert();
    await file.insert({ ...options, sessionReplay: true, replayMasking: "balanced" });
    const enabled = file.read();
    assert.equal(enabled.match(/import \{ ReplayInstrumentation \}/g)?.length, 1);
    assert.match(enabled, /maskTextSelector/);
    await file.insert({ ...options, sessionReplay: true, replayMasking: "balanced" });
    assert.equal(file.read(), enabled);
    await file.insert();
    assert.doesNotMatch(file.read(), /ReplayInstrumentation|faro-instrumentation-replay/);
    assert.match(file.read(), /export const App/);
  });

  test(`${kind}: code between generated imports and initialization is preserved`, async (t) => {
    const file = fixture(t);
    await file.insert();
    const userCode = '\nimport { custom } from "./custom";\n// Keep initialization order.\ncustom();\n\n';
    file.write(file.read().replace("\ninitializeFaro(", `${userCode}initializeFaro(`));
    await file.insert({ ...options, version: "2.0.0" });
    assert.ok(file.read().includes(userCode));
    assert.ok(file.read().indexOf("custom();") < file.read().indexOf("initializeFaro({"));
  });

  test(`${kind}: existing SDK imports and file syntax are preserved`, async (t) => {
    const app =
      kind === "react" ? "export const App = () => <div />;\n" : "export const identity = <T>(value: T) => value;\n";
    const file = fixture(t, app);
    await file.insert();
    file.write(
      file.read().replace("getWebInstrumentations, initializeFaro", "initializeFaro, getWebInstrumentations, extra"),
    );
    const imports = file.read().slice(0, file.read().indexOf("initializeFaro({"));
    await file.insert({ ...options, version: "2.0.0" });
    assert.ok(file.read().startsWith(imports));
    assert.ok(file.read().endsWith(app));
  });

  test(`${kind}: replay imports used by application code survive disabling replay`, async (t) => {
    const app = "export const customReplay = new ReplayInstrumentation();\n";
    const file = fixture(t, app);
    await file.insert({ ...options, sessionReplay: true });
    await file.insert();
    assert.equal(file.read().match(/new ReplayInstrumentation/g)?.length, 1);
    assert.match(file.read(), /import \{ ReplayInstrumentation \}/);
    assert.ok(file.read().endsWith(app));
  });

  for (const bindings of [
    "{ ReplayInstrumentation, /* keep */ extra }",
    "{ extra, /* keep */ ReplayInstrumentation, }",
    "extra, { /* keep */ ReplayInstrumentation, }",
  ]) {
    test(`${kind}: removing replay preserves other imports in ${bindings}`, async (t) => {
      const file = fixture(t, "export const keep = extra;\n");
      await file.insert({ ...options, sessionReplay: true });
      file.write(file.read().replace("{ ReplayInstrumentation }", bindings));
      await file.insert();
      assert.doesNotMatch(file.read(), /ReplayInstrumentation/);
      assert.match(file.read(), /\/\* keep \*\//);
      assert.match(file.read(), /extra.*faro-instrumentation-replay/);
      const { diagnostics } = ts.transpileModule(file.read(), { reportDiagnostics: true });
      assert.deepEqual(diagnostics, []);
    });
  }

  for (const [description, mutation] of [
    ["multiple calls", (source) => source + "\ninitializeFaro({});\n"],
    ["assigned result", (source) => source.replace("initializeFaro({", "const faro = initializeFaro({")],
    [
      "aliased initializer",
      (source) => source.replace("initializeFaro }", "initializeFaro as init }").replace("initializeFaro({", "init({"),
    ],
    ["syntax errors", (source) => source.replace("initializeFaro({", "initializeFaro({ broken: [")],
  ]) {
    test(`${kind}: existing initialization with ${description} is left untouched`, async (t) => {
      const file = fixture(t);
      await file.insert();
      const original = mutation(file.read());
      file.write(original);
      await assert.rejects(() => file.insert(), /Could not safely update/);
      assert.equal(file.read(), original);
    });
  }
}
