import ts from "typescript";
import {
  boundedSmt,
  compileExpression,
  evaluateExpression,
  smtInteger,
} from "./symbolic-expression.js";
import {
  type Bindings,
  type Environment,
  type Expression,
  type Scalar,
  type SymbolicRequest,
  symbolicLimits,
  unsupported,
} from "./symbolic-types.js";

type State = { env: Environment; path: string };
type Outcome = { path: string; value: Expression };
type FunctionNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;
export type SymbolicProgram = {
  query: string;
  variables: { name: string; smt: string; type: "integer" | "boolean" }[];
  reproduce(inputs: Record<string, Scalar>): {
    result: Scalar;
    assertion: Scalar;
  };
};

function parse(text: string) {
  const source = ts.createSourceFile(
    "symbolic.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length
  )
    unsupported("source_parse_error");
  return source;
}

function scalarType(type: ts.TypeNode | undefined) {
  if (type?.kind === ts.SyntaxKind.NumberKeyword) return "integer";
  if (type?.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  unsupported("explicit_scalar_parameter_type_required");
}

function findFunction(source: ts.SourceFile, name: string): FunctionNode {
  const found: (FunctionNode | undefined)[] = [];
  const bindingContains = (binding: ts.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) && bindingContains(element.name),
        );
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === name)
      found.push(undefined);
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name?.text === name
    )
      found.push(undefined);
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause,
        bindings = clause.namedBindings;
      if (
        clause.name?.text === name ||
        (bindings &&
          (ts.isNamespaceImport(bindings)
            ? bindings.name.text === name
            : bindings.elements.some((element) => element.name.text === name)))
      )
        found.push(undefined);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      found.push(statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (bindingContains(declaration.name))
          found.push(
            !statement.modifiers?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.DeclareKeyword ||
                modifier.kind === ts.SyntaxKind.AbstractKeyword,
            ) &&
              ts.isIdentifier(declaration.name) &&
              statement.declarationList.flags & ts.NodeFlags.Const &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer))
              ? declaration.initializer
              : undefined,
          );
  }
  if (found.length !== 1 || !found[0])
    unsupported("function_missing_ambiguous_or_unsupported");
  return found[0];
}

export function compileSymbolicProgram(
  request: SymbolicRequest,
): SymbolicProgram {
  if (Buffer.byteLength(request.source) > symbolicLimits.sourceBytes)
    unsupported("source_size_limit");
  if (!/^[A-Za-z_$][\w$]{0,127}$/.test(request.functionName))
    unsupported("invalid_function_name");
  if (request.assertion.length > symbolicLimits.assertionCharacters)
    unsupported("assertion_size_limit");
  const node = findFunction(parse(request.source), request.functionName);
  if (
    !node.body ||
    node.typeParameters?.length ||
    ("asteriskToken" in node && node.asteriskToken) ||
    node.modifiers?.some((modifier) =>
      [
        ts.SyntaxKind.AsyncKeyword,
        ts.SyntaxKind.DeclareKeyword,
        ts.SyntaxKind.AbstractKeyword,
      ].includes(modifier.kind),
    )
  )
    unsupported("unsupported_function_shape");
  if (node.getWidth() > symbolicLimits.targetCharacters)
    unsupported("target_size_limit");
  if (
    node.type &&
    ![ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword].includes(
      node.type.kind,
    )
  )
    unsupported("unsupported_return_type");
  let nodes = 0;
  const count = (item: ts.Node) => {
    nodes++;
    ts.forEachChild(item, count);
  };
  count(node);
  if (nodes > symbolicLimits.nodes) unsupported("syntax_node_limit");
  const env: Environment = new Map();
  const variables: SymbolicProgram["variables"] = [];
  const constraints: string[] = [];
  const names = new Set<string>(["result"]);
  if (
    !node.parameters.length ||
    node.parameters.length > symbolicLimits.inputs ||
    Object.keys(request.inputs).length !== node.parameters.length
  )
    unsupported("input_contract_mismatch");
  for (const [index, parameter] of node.parameters.entries()) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.questionToken ||
      parameter.dotDotDotToken ||
      parameter.initializer ||
      parameter.modifiers?.length
    )
      unsupported("unsupported_parameter");
    const name = parameter.name.text;
    if (
      name === "this" ||
      names.has(name) ||
      !Object.hasOwn(request.inputs, name)
    )
      unsupported("input_contract_mismatch");
    names.add(name);
    const type = scalarType(parameter.type),
      contract = request.inputs[name],
      smt = `p${index}`;
    if (type === "boolean") {
      if (contract.type !== "boolean")
        unsupported("input_contract_type_mismatch");
      env.set(name, { type, smt });
    } else {
      if (
        contract.type === "boolean" ||
        !Number.isSafeInteger(contract.min) ||
        !Number.isSafeInteger(contract.max) ||
        contract.min > contract.max
      )
        unsupported("finite_safe_integer_bounds_required");
      env.set(name, {
        type,
        smt,
        min: BigInt(contract.min),
        max: BigInt(contract.max),
      });
      constraints.push(
        `(assert (and (<= ${smtInteger(BigInt(contract.min))} ${smt}) (<= ${smt} ${smtInteger(BigInt(contract.max))})))`,
      );
    }
    variables.push({ name, smt, type });
  }
  const outcomes: Outcome[] = [];
  let expansions = 0;
  const execute = (statement: ts.Statement, state: State): State[] => {
    if (++expansions > symbolicLimits.nodes)
      unsupported("symbolic_expansion_limit");
    if (ts.isReturnStatement(statement)) {
      if (!statement.expression) unsupported("return_expression_required");
      outcomes.push({
        path: state.path,
        value: compileExpression(statement.expression, state.env),
      });
      if (outcomes.length > symbolicLimits.paths)
        unsupported("symbolic_path_limit");
      return [];
    }
    if (ts.isBlock(statement)) {
      const remaining = statements(statement.statements, {
        ...state,
        env: new Map(state.env),
      });
      return remaining.map((entry) => ({ ...entry, env: new Map(state.env) }));
    }
    if (ts.isIfStatement(statement)) {
      const condition = compileExpression(statement.expression, state.env);
      if (condition.type !== "boolean")
        unsupported("boolean_condition_required");
      const branch = (path: string) => ({
        env: new Map(state.env),
        path: boundedSmt(`(and ${state.path} ${path})`),
      });
      const yes = execute(statement.thenStatement, branch(condition.smt));
      const noState = branch(`(not ${condition.smt})`);
      return [
        ...yes,
        ...(statement.elseStatement
          ? execute(statement.elseStatement, noState)
          : [noState]),
      ];
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          unsupported("unsupported_local_declaration");
        const name = declaration.name.text;
        // A declaration may be visited in several paths, but scope shadowing is rejected below.
        const value = compileExpression(declaration.initializer, state.env);
        if (declaration.type && scalarType(declaration.type) !== value.type)
          unsupported("local_type_mismatch");
        state.env.set(name, value);
      }
      return [state];
    }
    unsupported(`unsupported_statement:${ts.SyntaxKind[statement.kind]}`);
  };
  const statements = (
    items: readonly ts.Statement[],
    initial: State,
  ): State[] => {
    let active = [initial];
    for (const item of items) {
      if (!active.length) unsupported("unreachable_statement");
      active = active.flatMap((state) => execute(item, state));
      if (active.length > symbolicLimits.paths)
        unsupported("symbolic_path_limit");
    }
    return active;
  };
  const checkNames = (item: ts.Node) => {
    if (ts.isVariableDeclaration(item)) {
      if (!ts.isIdentifier(item.name) || names.has(item.name.text))
        unsupported("shadowed_or_duplicate_local");
      names.add(item.name.text);
    }
    ts.forEachChild(item, checkNames);
  };
  checkNames(node.body);
  if (ts.isBlock(node.body)) {
    if (
      statements(node.body.statements, { env: new Map(env), path: "true" })
        .length
    )
      unsupported("all_paths_must_return");
  } else
    outcomes.push({ path: "true", value: compileExpression(node.body, env) });
  if (!outcomes.length) unsupported("all_paths_must_return");
  if (
    node.type &&
    outcomes.some((outcome) => outcome.value.type !== scalarType(node.type))
  )
    unsupported("return_type_mismatch");
  let result = outcomes.at(-1)!.value;
  for (const outcome of outcomes.slice(0, -1).reverse()) {
    if (outcome.value.type !== result.type) unsupported("mixed_return_types");
    result = {
      ...result,
      smt: boundedSmt(
        `(ite ${outcome.path} ${outcome.value.smt} ${result.smt})`,
      ),
    };
  }
  const assertionSource = parse(`const __assertion = (${request.assertion});`);
  if (
    assertionSource.statements.length !== 1 ||
    !ts.isVariableStatement(assertionSource.statements[0]) ||
    assertionSource.statements[0].declarationList.declarations.length !== 1
  )
    unsupported("assertion_expression_required");
  const assertion =
    assertionSource.statements[0].declarationList.declarations[0].initializer;
  if (
    !assertion ||
    !ts.isParenthesizedExpression(assertion) ||
    assertion.getStart(assertionSource) !== "const __assertion = ".length ||
    assertion.getText(assertionSource) !== `(${request.assertion})`
  )
    unsupported("assertion_expression_required");
  const assertionEnv = new Map(env);
  if (result.type === "integer") {
    const integers = outcomes
      .map((entry) => entry.value)
      .filter((value) => value.type === "integer");
    result = {
      ...result,
      min: integers.reduce(
        (min, value) => (value.min < min ? value.min : min),
        result.min,
      ),
      max: integers.reduce(
        (max, value) => (value.max > max ? value.max : max),
        result.max,
      ),
    };
  }
  assertionEnv.set("result", result);
  const property = compileExpression(assertion, assertionEnv);
  if (property.type !== "boolean") unsupported("boolean_assertion_required");
  const query = [
    "(set-logic QF_NIA)",
    ...variables.map(
      (entry) =>
        `(declare-const ${entry.smt} ${entry.type === "integer" ? "Int" : "Bool"})`,
    ),
    ...constraints,
    `(assert (not ${property.smt}))`,
  ].join("\n");
  if (Buffer.byteLength(query) > symbolicLimits.maximumSmtBytes)
    unsupported("smt_size_limit");
  return {
    query,
    variables,
    reproduce: (inputs) => {
      const bindings: Bindings = new Map(Object.entries(inputs));
      const value = evaluateFunction(node, bindings);
      bindings.set("result", value);
      return {
        result: value,
        assertion: evaluateExpression(assertion, bindings),
      };
    },
  };
}

function evaluateFunction(node: FunctionNode, env: Bindings): Scalar {
  const run = (
    statement: ts.Statement,
    bindings: Bindings,
  ): { value: Scalar } | undefined => {
    if (ts.isReturnStatement(statement) && statement.expression)
      return { value: evaluateExpression(statement.expression, bindings) };
    if (ts.isBlock(statement)) {
      const nested = new Map(bindings);
      for (const item of statement.statements) {
        const result = run(item, nested);
        if (result) return result;
      }
      return;
    }
    if (ts.isIfStatement(statement)) {
      if (evaluateExpression(statement.expression, bindings))
        return run(statement.thenStatement, bindings);
      if (statement.elseStatement)
        return run(statement.elseStatement, bindings);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          bindings.set(
            declaration.name.text,
            evaluateExpression(declaration.initializer, bindings),
          );
      return;
    }
    unsupported("concrete_unsupported_statement");
  };
  if (!node.body) unsupported("concrete_missing_body");
  if (!ts.isBlock(node.body)) return evaluateExpression(node.body, env);
  const value = run(node.body, env);
  if (!value) unsupported("concrete_missing_return");
  return value.value;
}
