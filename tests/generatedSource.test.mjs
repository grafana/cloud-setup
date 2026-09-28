import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import ts from "typescript";

// Exercise the real generators and writes without an Assistant request.
mock.module("../dist/harness/index.js", {
  namedExports: {
    fileToolsWithWrite: (cwd) => cwd,
    runTask: async (_stack, _task, cwd) => {
      mkdirSync(path.join(cwd, "components"), { recursive: true });
      const component = path.join(cwd, "components/frontend-observability.tsx");
      if (!existsSync(component)) writeFileSync(component, "");
      mkdirSync(path.join(cwd, "app"), { recursive: true });
      writeFileSync(
        path.join(cwd, "app/layout.tsx"),
        "import FrontendObservability from '../components/frontend-observability';\n" +
          "export default function Layout({ children }) { return <html><body><FrontendObservability />{children}</body></html>; }\n",
      );
    },
  },
});
const { insertFaroSnippet } = await import("../dist/products/frontendO11y/instrument.js");
const { instrumentReact } = await import("../dist/products/frontendO11y/react.js");
const { instrumentNextjs } = await import("../dist/products/frontendO11y/nextjs.js");
mock.module("../dist/products/syntheticMonitoring/authoring.js", {
  namedExports: { authorChecks: () => assert.fail("default candidates must not invoke the Assistant") },
});
const { candidatesFor } = await import("../dist/products/syntheticMonitoring/discover.js");

const defaults = {
  name: "test-app",
  version: "1.0.0",
  collectorUrl: "https://collector.example/collect",
  environmentExpr: "process.env.NODE_ENV",
  sessionPersistent: false,
  sessionReplay: false,
  replayMasking: "strict",
  samplingRate: 1,
};
const metadata = [
  ["quotes", 'O\'Reilly "storefront"'],
  ["backslashes", String.raw`C:\apps\new\frontend`],
  ["control characters", "first line\nsecond line\r\n\t\0"],
  ["Unicode", "Zürich 🦕\u2028\u2029\ud800"],
  ["source-like text", "'); throw new Error('not code'); //"],
];

function parse(source) {
  const { diagnostics } = ts.transpileModule(source, {
    fileName: "fixture.tsx",
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  });
  assert.deepEqual(diagnostics, [], "generated source must parse");
  return ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX);
}
function findCalls(source, matches) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && matches(node.expression)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
function property(object, key) {
  assert.ok(ts.isObjectLiteralExpression(object));
  const value = object.properties.find((node) => ts.isPropertyAssignment(node) && node.name.getText() === key);
  assert.ok(value, `missing ${key}`);
  return value.initializer;
}
function assertLiteral(node, expected) {
  assert.ok(ts.isStringLiteral(node), "metadata must stay a string literal");
  assert.equal(node.text, expected);
}
function assertMetadata(source, expected) {
  const tree = parse(source);
  const calls = findCalls(tree, (node) => ts.isIdentifier(node) && node.text === "initializeFaro");
  assert.equal(calls.length, 1);
  const config = calls[0].arguments[0];
  assertLiteral(property(config, "url"), expected.collectorUrl);
  const app = property(config, "app");
  assertLiteral(property(app, "name"), expected.name);
  assertLiteral(property(app, "version"), expected.version);
  assert.equal(property(app, "environment").getText(), expected.environmentExpr);
}

for (const kind of ["javascript", "react", "nextjs"])
  for (const [description, value] of metadata)
    test(`${kind}: ${description} remain literal values on initial setup and reruns`, async (t) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "cloud-setup-literals-"));
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      const entry = "main.tsx";
      const original = "// Keep the application entry.\nexport const App = () => null;\n";
      writeFileSync(path.join(cwd, entry), original);
      const options = {
        ...defaults,
        name: value,
        version: `release-${value}`,
        collectorUrl: `${defaults.collectorUrl}/${value}`,
      };
      const generate = async (config) => {
        if (kind === "nextjs") {
          const result = await instrumentNextjs(cwd, "https://stack.grafana.net", config);
          assert.equal(result.complete, true);
          return readFileSync(path.join(cwd, result.componentFile), "utf8");
        }
        if (kind === "react") {
          const result = await instrumentReact(cwd, "https://stack.grafana.net", entry, config);
          assert.equal(result.complete, true);
        } else insertFaroSnippet(cwd, { kind, file: entry }, config);
        const source = readFileSync(path.join(cwd, entry), "utf8");
        assert.ok(source.endsWith(original));
        return source;
      };
      const first = await generate(options);
      assertMetadata(first, options);
      assert.equal(await generate(options), first);
      const changed = { ...options, name: `${value} updated`, version: `${value} v2` };
      assertMetadata(await generate(changed), changed);
    });

test("broken-link scripts preserve quoted target URLs as literals", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { headers: { "content-type": "text/html" } }));
  for (const url of [
    "https://example.com/O'Reilly",
    'https://example.com/"quoted"?path=one\\two',
    "https://example.com/🦕",
  ]) {
    const candidates = await candidatesFor(url);
    const scripted = candidates.filter((candidate) => candidate.settings.browser);
    assert.equal(scripted.length, 1);
    for (const candidate of scripted) {
      const tree = parse(candidate.settings.browser.script);
      const calls = findCalls(tree, (node) => ts.isPropertyAccessExpression(node) && node.name.text === "goto");
      assert.equal(calls.length, 1);
      assertLiteral(calls[0].arguments[0], url);
    }
  }
});
