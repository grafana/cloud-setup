import ts from "typescript";

interface Edit {
  start: number;
  end: number;
  text: string;
}

function moduleName(node: ts.ImportDeclaration): string {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
}

function namedImports(node: ts.ImportDeclaration): readonly ts.ImportSpecifier[] {
  const bindings = node.importClause?.namedBindings;
  return !node.importClause?.isTypeOnly && bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
}

function isBinding(specifier: ts.ImportSpecifier, name: string): boolean {
  return !specifier.isTypeOnly && specifier.name.text === name && (specifier.propertyName?.text ?? name) === name;
}

function isInitialization(node: ts.Node): node is ts.ExpressionStatement {
  return (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "initializeFaro"
  );
}

const REPLAY_MODULE = "@grafana/faro-instrumentation-replay";

// Edit only Faro statements, never the span between an import and its call.
// Parsing tolerates formatting changes without reprinting the user's file.
export function updateFaroSnippet(existing: string, snippet: string, fileName: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const source = ts.createSourceFile(fileName, existing, ts.ScriptTarget.Latest, true);
  const generated = ts.createSourceFile("snippet.ts", snippet, ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const wanted = generated.statements.filter(ts.isImportDeclaration);
  const sdk = moduleName(wanted[0]!);
  const sdkImports = imports.filter((node) => moduleName(node) === sdk);
  const calls = source.statements.filter(isInitialization);
  const unsafe = () =>
    new Error(
      "Could not safely update the existing Faro initialization. Review the entry file before rerunning setup.",
    );

  // Parser recovery can make a malformed call appear to include later
  // application code. Refuse to use those boundaries for an edit.
  const { diagnostics } = ts.transpileModule(existing, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
  });
  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw unsafe();

  if (sdkImports.length === 0 && calls.length === 0) {
    // Existing helper imports may be part of a custom setup. Do not add
    // duplicate bindings when there is no recognizable initialization.
    if (imports.some((node) => wanted.some((other) => moduleName(node) === moduleName(other)))) throw unsafe();
    const initial = snippet.replace(/\n/g, eol);
    return existing ? `${initial}${eol}${existing}` : initial;
  }
  if (
    calls.length !== 1 ||
    !sdkImports.some((node) => namedImports(node).some((item) => isBinding(item, "initializeFaro")))
  ) {
    throw unsafe();
  }

  const call = calls[0]!;
  const additions: string[] = [];
  for (const declaration of wanted) {
    const required = namedImports(declaration);
    const available = imports.filter((node) => moduleName(node) === moduleName(declaration)).flatMap(namedImports);
    const missing = required.filter((item) => !available.some((other) => isBinding(other, item.name.text)));
    if (missing.length === 0) continue;
    // An aliased or partially edited import needs manual review. Normal
    // reruns only add a whole import, e.g. when enabling Session Replay.
    if (missing.length !== required.length || available.length > 0) throw unsafe();
    additions.push(declaration.getText(generated));
  }

  const initializer = generated.statements.find(isInitialization)!;
  const edits: Edit[] = [
    {
      start: call.getStart(source),
      end: call.end,
      text: [...additions, initializer.getText(generated)].join("\n").replace(/\n/g, eol),
    },
  ];

  if (!wanted.some((node) => moduleName(node) === REPLAY_MODULE)) {
    // A user may use ReplayInstrumentation elsewhere. Keep its import in
    // that case even when this initialization no longer enables replay.
    const usesReplay = (node: ts.Node): boolean => {
      if (node === call || ts.isImportDeclaration(node)) return false;
      return (
        (ts.isIdentifier(node) && node.text === "ReplayInstrumentation") || Boolean(ts.forEachChild(node, usesReplay))
      );
    };
    if (!usesReplay(source)) {
      for (const declaration of imports.filter((node) => moduleName(node) === REPLAY_MODULE)) {
        const bindings = namedImports(declaration);
        const index = bindings.findIndex((item) => isBinding(item, "ReplayInstrumentation"));
        if (index < 0) continue;
        const binding = bindings[index]!;
        if (bindings.length === 1 && !declaration.importClause?.name) {
          const newline = /^[\t ]*(?:\r?\n|$)/.exec(existing.slice(declaration.end))?.[0] ?? "";
          edits.push({ start: declaration.getStart(source), end: declaration.end + newline.length, text: "" });
        } else {
          // Keep other specifiers and comments byte-for-byte. Removing a
          // binding and its comma leaves valid syntax even with a default import.
          edits.push({ start: binding.getStart(source), end: binding.end, text: "" });
          {
            const commaFrom =
              bindings.length > 1 && index === bindings.length - 1 ? bindings[index - 1]!.end : binding.end;
            const scanner = ts.createScanner(
              ts.ScriptTarget.Latest,
              true,
              ts.LanguageVariant.Standard,
              existing,
              undefined,
              commaFrom,
            );
            if (scanner.scan() === ts.SyntaxKind.CommaToken) {
              edits.push({ start: scanner.getTokenPos(), end: scanner.getTextPos(), text: "" });
            } else if (bindings.length > 1) {
              throw unsafe();
            }
          }
        }
      }
    }
  }

  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), existing);
}
