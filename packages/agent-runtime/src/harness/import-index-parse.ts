import ts from "typescript";

// Per-file facts for the import index: import and re-export specifiers, the
// names they bind with their first use line, and the file's own exports.

export type Binding = {
  imported: string; // export name, "default", or "*" for a namespace binding
  local?: string;
  line?: number; // first use of the local binding outside import/export statements
  members?: Record<string, number>; // namespace bindings: ns.member → first use line
};
export type ImportRecord = { spec: string; bindings: Binding[] };
// as "*" with from "*" is `export * from`; from "*" alone is `export * as ns from`.
export type Reexport = { spec: string; from: string; as: string };
export type Entry = {
  hash: string;
  imports: ImportRecord[];
  reexports: Reexport[];
  exports: Map<string, "type" | "value">;
  defaultName?: string;
  order: string[];
};

export function parseEntry(path: string, text: string, hash: string): Entry {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const imports: ImportRecord[] = [];
  const reexports: Reexport[] = [];
  const exports = new Map<string, "type" | "value">();
  const declared = new Map<string, "type" | "value">();
  const importedLocals = new Map<string, { spec: string; imported: string }>();
  const localExports: Array<{ local: string; as: string; type: boolean }> = [];
  const excluded: Array<[number, number]> = [];
  let defaultName: string | undefined;
  const bind = (spec: string, bindings: Binding[]) => {
    imports.push({ spec, bindings });
    for (const binding of bindings)
      if (binding.local) importedLocals.set(binding.local, { spec, imported: binding.imported });
  };
  const declare = (name: string, kind: "type" | "value", exported: boolean, isDefault = false) => {
    if (declared.get(name) !== "value") declared.set(name, kind);
    if (isDefault) { exports.set("default", "value"); defaultName = name || undefined; }
    else if (exported && exports.get(name) !== "value") exports.set(name, kind);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      excluded.push([statement.pos, statement.end]);
      const spec = stringText(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (!spec || clause?.isTypeOnly) continue;
      const bindings: Binding[] = [];
      if (clause?.name) bindings.push({ imported: "default", local: clause.name.text });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.push({ imported: "*", local: named.name.text });
      else if (named) for (const element of named.elements)
        if (!element.isTypeOnly) bindings.push({ imported: (element.propertyName ?? element.name).text, local: element.name.text });
      if (!clause || bindings.length) bind(spec, bindings);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (statement.isTypeOnly || !ts.isExternalModuleReference(reference)) continue;
      excluded.push([statement.pos, statement.end]);
      const spec = stringText(reference.expression);
      if (spec) bind(spec, [{ imported: "*", local: statement.name.text }]);
    } else if (ts.isExportDeclaration(statement)) {
      excluded.push([statement.pos, statement.end]);
      if (statement.isTypeOnly) continue;
      const spec = statement.moduleSpecifier && stringText(statement.moduleSpecifier);
      const clause = statement.exportClause;
      if (spec && !clause) reexports.push({ spec, from: "*", as: "*" });
      else if (spec && clause && ts.isNamespaceExport(clause)) reexports.push({ spec, from: "*", as: clause.name.text });
      else if (clause && ts.isNamedExports(clause)) for (const element of clause.elements) {
        const from = (element.propertyName ?? element.name).text;
        if (spec && !element.isTypeOnly) reexports.push({ spec, from, as: element.name.text });
        else if (!spec) localExports.push({ local: from, as: element.name.text, type: element.isTypeOnly });
      }
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) continue;
      if (ts.isIdentifier(statement.expression)) localExports.push({ local: statement.expression.text, as: "default", type: false });
      else declare("", "value", true, true);
    } else {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
      const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = exported && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
        declare(statement.name?.text ?? "", "value", exported, isDefault);
      else if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          for (const name of bindingNames(declaration.name)) declare(name, "value", exported);
      else if (ts.isEnumDeclaration(statement) || (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)))
        declare(statement.name.text, "value", exported);
      else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
        declare(statement.name.text, "type", exported);
    }
  }
  if (text.includes("import(") || text.includes("require(")) collectDynamicImports(source, bind, excluded);
  for (const { local, as, type } of localExports) {
    const imported = importedLocals.get(local);
    if (imported && !type) reexports.push({ spec: imported.spec, from: imported.imported, as });
    else if (!imported) {
      exports.set(as, type ? "type" : declared.get(local) ?? "value");
      if (as === "default") defaultName = local;
    }
  }
  markUses(text, imports, excluded);
  return { hash, imports, reexports, exports, defaultName, order: [...exports.keys(), ...reexports.map((item) => item.as)] };
}

function collectDynamicImports(source: ts.SourceFile, bind: (spec: string, bindings: Binding[]) => void,
  excluded: Array<[number, number]>) {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const spec = moduleCall(node.initializer);
      if (spec) {
        excluded.push([node.pos, node.end]);
        const name = node.name;
        bind(spec, ts.isIdentifier(name) ? [{ imported: "*", local: name.text }]
          : ts.isObjectBindingPattern(name) ? name.elements.flatMap((element) =>
            ts.isIdentifier(element.name) && !element.dotDotDotToken
              ? [{ imported: (element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName : element.name).text, local: element.name.text }] : [])
          : []);
        return;
      }
    }
    const spec = ts.isCallExpression(node) ? moduleCall(node) : undefined;
    if (spec) bind(spec, []);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function moduleCall(node: ts.Expression): string | undefined {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const callee = node.expression;
  if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && callee.text === "require"))
    return undefined;
  return stringText(node.arguments[0]!);
}

// First use line of each import binding: a word-boundary scan of the file,
// outside import/export statements and property accesses.
function markUses(text: string, imports: ImportRecord[], excluded: Array<[number, number]>) {
  const wanted = new Map<string, Binding[]>();
  for (const binding of imports.flatMap((record) => record.bindings))
    if (binding.local) wanted.set(binding.local, [...wanted.get(binding.local) ?? [], binding]);
  if (!wanted.size) return;
  excluded.sort((a, b) => a[0] - b[0]);
  let range = 0;
  let line = 1;
  let counted = 0;
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const at = match.index;
    const bindings = wanted.get(match[0]);
    if (!bindings) continue;
    while (range < excluded.length && excluded[range]![1] <= at) range++;
    if (range < excluded.length && excluded[range]![0] <= at) continue;
    if (text[at - 1] === "." && text[at - 2] !== "." || /[\w$]/u.test(text[at - 1] ?? "")) continue;
    for (let next = text.indexOf("\n", counted); next !== -1 && next < at; next = text.indexOf("\n", next + 1)) line++;
    counted = at;
    for (const binding of bindings) {
      binding.line ??= line;
      if (binding.imported !== "*") continue;
      const member = /^\??\.([A-Za-z_$][\w$]*)/u.exec(text.slice(at + match[0].length, at + match[0].length + 200));
      if (member) (binding.members ??= {})[member[1]!] ??= line;
    }
  }
}

export function uses(binding: Binding): Array<[string, number]> {
  if (binding.imported === "*") return Object.entries(binding.members ?? {});
  return binding.line ? [[binding.imported, binding.line]] : [];
}
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function stringText(node: ts.Node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function scriptKind(path: string) {
  if (/\.tsx$/u.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/u.test(path)) return ts.ScriptKind.TS;
  return /\.jsx$/u.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}
