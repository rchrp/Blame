import ts from "typescript";
import { unsupported } from "./symbolic-types.js";

/** Reject visible shadowing/writes; imported effects remain an explicit assumption. */
export function symbolicMathAssumptions(source: ts.SourceFile, target: ts.Node): string[] {
  let used = false;
  const detect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Math") used = true;
    ts.forEachChild(node, detect);
  };
  detect(target);
  if (!used) return [];
  const nameContainsMath = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === "Math";
    return ts.forEachChild(node, nameContainsMath) ?? false;
  };
  const check = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
        ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name && nameContainsMath(node.name))
      unsupported("math_binding_shadowed");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && nameContainsMath(node.left) ||
        ts.isDeleteExpression(node) && nameContainsMath(node.expression)) unsupported("math_mutation_in_module");
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) &&
        nameContainsMath(node.operand)) unsupported("math_mutation_in_module");
    if (ts.isIdentifier(node) && node.text === "Math" &&
        (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node)) unsupported("math_escape_in_module");
    ts.forEachChild(node, check);
  };
  check(source);
  return ["Math.min/max/abs denote standard ECMAScript intrinsics. External rebinding and module/import side effects are not modeled."];
}
