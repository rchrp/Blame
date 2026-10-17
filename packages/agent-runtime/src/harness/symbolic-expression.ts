import ts from "typescript";
import {
  type Bindings,
  type Environment,
  type Expression,
  type Scalar,
  symbolicLimits,
  unsupported,
} from "./symbolic-types.js";

const safe = BigInt(Number.MAX_SAFE_INTEGER);
export const smtInteger = (value: bigint) =>
  value < 0n ? `(- ${-value})` : String(value);

export function boundedSmt(smt: string): string {
  if (smt.length > symbolicLimits.maximumSmtBytes)
    unsupported("smt_size_limit");
  return smt;
}

function boolean(smt: string): Expression {
  return { type: "boolean", smt: boundedSmt(smt) };
}

function integer(smt: string, min: bigint, max: bigint): Extract<Expression, {type:"integer"}> {
  if (min < -safe || max > safe) unsupported("unsafe_integer_intermediate");
  return { type: "integer", smt: boundedSmt(smt), min, max };
}

export function compileExpression(
  node: ts.Expression,
  env: Environment,
): Expression {
  if (ts.isParenthesizedExpression(node))
    return compileExpression(node.expression, env);
  if (ts.isIdentifier(node)) {
    const value = env.get(node.text);
    if (!value) unsupported(`unbound_identifier:${node.text}`);
    return value;
  }
  if (ts.isCallExpression(node)) {
    const method = mathMethod(node, env.has("Math"));
    const args = node.arguments.map(arg => compileExpression(arg, env));
    if (args.some(arg => arg.type !== "integer")) unsupported("math_integer_arguments_required");
    const integers = args as Extract<Expression, {type:"integer"}>[];
    if (method === "abs") {
      const a = integers[0]!;
      return integer(`(ite (< ${a.smt} 0) (- ${a.smt}) ${a.smt})`,
        a.min >= 0n ? a.min : a.max <= 0n ? -a.max : 0n,
        -a.min > a.max ? -a.min : a.max);
    }
    return integers.slice(1).reduce((a, b) => integer(
      `(ite (${method === "min" ? "<" : ">"} ${a.smt} ${b.smt}) ${a.smt} ${b.smt})`,
      method === "min" ? (a.min < b.min ? a.min : b.min) : (a.min > b.min ? a.min : b.min),
      method === "min" ? (a.max < b.max ? a.max : b.max) : (a.max > b.max ? a.max : b.max)), integers[0]!);
  }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (!Number.isSafeInteger(value)) unsupported("non_safe_integer_literal");
    return integer(smtInteger(BigInt(value)), BigInt(value), BigInt(value));
  }
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  )
    return boolean(node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false");
  if (ts.isPrefixUnaryExpression(node)) {
    const value = compileExpression(node.operand, env);
    if (
      node.operator === ts.SyntaxKind.ExclamationToken &&
      value.type === "boolean"
    )
      return boolean(`(not ${value.smt})`);
    if (value.type !== "integer") unsupported("unary_operand_type");
    if (node.operator === ts.SyntaxKind.PlusToken) return value;
    if (node.operator === ts.SyntaxKind.MinusToken)
      return integer(`(- ${value.smt})`, -value.max, -value.min);
    unsupported("unsupported_unary_operator");
  }
  if (ts.isConditionalExpression(node)) {
    const condition = compileExpression(node.condition, env);
    const yes = compileExpression(node.whenTrue, env);
    const no = compileExpression(node.whenFalse, env);
    if (condition.type !== "boolean" || yes.type !== no.type)
      unsupported("conditional_operand_type");
    const smt = `(ite ${condition.smt} ${yes.smt} ${no.smt})`;
    return yes.type === "integer" && no.type === "integer"
      ? integer(
          smt,
          yes.min < no.min ? yes.min : no.min,
          yes.max > no.max ? yes.max : no.max,
        )
      : boolean(smt);
  }
  if (!ts.isBinaryExpression(node))
    unsupported(`unsupported_expression:${ts.SyntaxKind[node.kind]}`);
  const a = compileExpression(node.left, env);
  const b = compileExpression(node.right, env);
  const operator = node.operatorToken.kind;
  const equality =
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (equality) {
    if (a.type !== b.type) unsupported("equality_operand_type");
    const smt = `(= ${a.smt} ${b.smt})`;
    return boolean(
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? smt : `(not ${smt})`,
    );
  }
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken
  ) {
    if (a.type !== "boolean" || b.type !== "boolean")
      unsupported("logical_operand_type");
    return boolean(
      `(${operator === ts.SyntaxKind.AmpersandAmpersandToken ? "and" : "or"} ${a.smt} ${b.smt})`,
    );
  }
  if (a.type !== "integer" || b.type !== "integer")
    unsupported("integer_operand_type");
  const comparisons = new Map([
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
  ]);
  const comparison = comparisons.get(operator);
  if (comparison) return boolean(`(${comparison} ${a.smt} ${b.smt})`);
  if (operator === ts.SyntaxKind.PlusToken)
    return integer(`(+ ${a.smt} ${b.smt})`, a.min + b.min, a.max + b.max);
  if (operator === ts.SyntaxKind.MinusToken)
    return integer(`(- ${a.smt} ${b.smt})`, a.min - b.max, a.max - b.min);
  if (operator === ts.SyntaxKind.AsteriskToken) {
    const bounds = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
    return integer(
      `(* ${a.smt} ${b.smt})`,
      bounds.reduce((x, y) => (x < y ? x : y)),
      bounds.reduce((x, y) => (x > y ? x : y)),
    );
  }
  unsupported("unsupported_binary_operator");
}

// This interpreter evaluates the original supported AST using JavaScript scalar
// operations. It does not evaluate SMT or dynamically execute repository code.
export function evaluateExpression(node: ts.Expression, env: Bindings): Scalar {
  if (ts.isParenthesizedExpression(node))
    return evaluateExpression(node.expression, env);
  if (ts.isIdentifier(node)) {
    if (!env.has(node.text)) unsupported("concrete_unbound_identifier");
    return env.get(node.text)!;
  }
  if (ts.isCallExpression(node)) {
    const method = mathMethod(node, env.has("Math"));
    const values = node.arguments.map(arg => evaluateExpression(arg, env));
    if (!values.every(value => typeof value === "number" && Number.isSafeInteger(value)))
      unsupported("concrete_math_integer_arguments_required");
    const args = values as number[];
    return method === "abs" ? Math.abs(args[0]!) : method === "min" ? Math.min(...args) : Math.max(...args);
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node)) {
    const value = evaluateExpression(node.operand, env);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    if (typeof value !== "number") unsupported("concrete_unary_type");
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return +value;
  }
  if (ts.isConditionalExpression(node))
    return evaluateExpression(
      evaluateExpression(node.condition, env) ? node.whenTrue : node.whenFalse,
      env,
    );
  if (ts.isBinaryExpression(node)) {
    const a = evaluateExpression(node.left, env);
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return a && evaluateExpression(node.right, env);
    if (op === ts.SyntaxKind.BarBarToken)
      return a || evaluateExpression(node.right, env);
    const b = evaluateExpression(node.right, env);
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
    if (typeof a !== "number" || typeof b !== "number")
      unsupported("concrete_integer_type");
    if (op === ts.SyntaxKind.PlusToken) return a + b;
    if (op === ts.SyntaxKind.MinusToken) return a - b;
    if (op === ts.SyntaxKind.AsteriskToken) return a * b;
    if (op === ts.SyntaxKind.LessThanToken) return a < b;
    if (op === ts.SyntaxKind.LessThanEqualsToken) return a <= b;
    if (op === ts.SyntaxKind.GreaterThanToken) return a > b;
    if (op === ts.SyntaxKind.GreaterThanEqualsToken) return a >= b;
  }
  unsupported("concrete_unsupported_expression");
}

function mathMethod(node: ts.CallExpression, shadowed: boolean): "min" | "max" | "abs" {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== "Math")
    unsupported("unsupported_expression:CallExpression");
  if (shadowed || node.questionDotToken || node.typeArguments?.length || !ts.isPropertyAccessExpression(callee) ||
      callee.questionDotToken || !ts.isIdentifier(callee.expression) || callee.expression.text !== "Math" ||
      !["min", "max", "abs"].includes(callee.name.text) || node.arguments.some(ts.isSpreadElement) ||
      node.arguments.length < 1 || node.arguments.length > 8 || callee.name.text === "abs" && node.arguments.length !== 1)
    unsupported("unsupported_or_shadowed_math_call");
  return callee.name.text as "min" | "max" | "abs";
}
