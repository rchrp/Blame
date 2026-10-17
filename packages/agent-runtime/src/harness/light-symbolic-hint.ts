import ts from "typescript";
import { compileSymbolicProgram } from "./symbolic-program.js";
import type { SymbolicInput } from "./symbolic-types.js";

/** A small opt-in discovery hint; no solver call, inferred property or supplied production bounds. */
export function symbolicReadHints(path: string, text: string, targetName?: string) {
  if (!/\.(?:[cm]?ts|tsx)$/iu.test(path) || Buffer.byteLength(text) > 256 * 1024) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = source.statements.flatMap<{name:string;node:ts.FunctionDeclaration|ts.ArrowFunction|ts.FunctionExpression}>(statement => {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      return [{ name: statement.name.text, node: statement }];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration =>
      ts.isIdentifier(declaration.name) && declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? [{ name: declaration.name.text, node: declaration.initializer }] : []);
    return [];
  }).filter(item => !targetName || item.name === targetName).slice(0, 8);
  const hints = [];
  for (const {name, node} of functions) {
    if (!node.parameters.length || node.parameters.length > 8 || node.getWidth() > 16 * 1024) continue;
    const inputs: Record<string, SymbolicInput> = {};
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) break;
      if (parameter.type?.kind === ts.SyntaxKind.NumberKeyword) inputs[parameter.name.text] = { min: 0, max: 0 };
      else if (parameter.type?.kind === ts.SyntaxKind.BooleanKeyword) inputs[parameter.name.text] = { type: "boolean" };
    }
    if (Object.keys(inputs).length !== node.parameters.length) continue;
    try {
      // Shape screening only. The zero domain is never emitted as a proposed analysis.
      compileSymbolicProgram({ source: text, functionName: name, inputs, assertion: "true" });
      hints.push({ target: `${path}#${name}`, parameters: Object.keys(inputs),
        next: "run_task kind=analyze: supply your own bounded inputs and a nontrivial assertion about result. Then exercise any witness in a real test. Shape hint only; no property or input-domain proof, validation or edit coverage." });
      if (hints.length === 2) break;
    } catch { /* Unsupported shapes get no suggestion, never a positive claim. */ }
  }
  return hints;
}
