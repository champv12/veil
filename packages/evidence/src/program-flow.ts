import path from "node:path";
import ts from "typescript";
import {
  identifySemanticReview,
  type ImpactRelationship,
  type ImpactSymbolReference,
  type ReviewEvidence,
  type SemanticReviewIdentity,
} from "@veil/contracts";
import { buildStructuralSemanticReview } from "./semantic-review.js";

export interface ProgramFlowReviewInput {
  workspaceTreeId: `sha256:${string}`;
  sanitizedDiff: string;
  sources: Array<{ path: string; content: string }>;
  omittedSources?: string[];
  verification?: Array<{ checkId: string; result: "passed" | "failed" | "skipped" }>;
}

interface DeclarationRecord {
  key: string;
  path: string;
  symbol: string;
  scope: "source" | "nested" | "member";
  exportedNames: string[];
  lexicalScope?: ts.Node;
  sourceFile: ts.SourceFile;
  node: ts.FunctionLikeDeclaration;
  reference: ImpactSymbolReference;
}

interface ImportBinding {
  targetPath: string | undefined;
  importedName: string;
}

const SUPPORTED_SOURCE = /\.[cm]?[jt]sx?$/i;

export function buildProgramFlowSemanticReview(input: ProgramFlowReviewInput): SemanticReviewIdentity {
  const structural = buildStructuralSemanticReview(input);
  const supported = input.sources.filter((source) => SUPPORTED_SOURCE.test(source.path));
  const unsupportedChanged = changedPaths(input.sanitizedDiff).filter((changed) => !SUPPORTED_SOURCE.test(changed));
  if (supported.length === 0) {
    return identifySemanticReview({
      ...structural.artifact,
      analysis: { engine: "veil-typescript-flow", version: "1.0.0", deterministic: true },
      impact: {
        coverage: {
          callFlow: "unsupported",
          dataFlow: "unsupported",
          reasons: ["Program-flow analysis currently supports TypeScript and JavaScript source only."],
        },
        relationships: [],
        impactedSymbols: [],
        risk: "unknown",
      },
    });
  }

  const sourceFiles = new Map<string, ts.SourceFile>();
  const sourceText = new Map<string, string>();
  for (const source of supported) {
    const normalizedPath = normalizeSourcePath(source.path);
    sourceText.set(normalizedPath, source.content);
    sourceFiles.set(normalizedPath, ts.createSourceFile(
      normalizedPath,
      source.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(normalizedPath),
    ));
  }

  const declarations = collectDeclarations(sourceFiles);
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  const byName = indexDeclarationsByName(declarations);
  const imports = collectImports(sourceFiles, sourceText);
  const relationships: ImpactRelationship[] = [];
  const dynamicReasons = new Set<string>();
  const unresolvedCallReasons = new Set<string>();
  const dataReasons = new Set<string>();
  let edgeSequence = 0;

  for (const declaration of declarations) {
    const localVariables = new Map<string, ImpactSymbolReference>();
    visitFunctionBody(declaration.node, (node) => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicReasons.add("Dynamic import prevents complete static call-flow coverage.");
        if (ts.isIdentifier(node.expression) && node.expression.text === "eval") dynamicReasons.add("eval prevents complete static call/data-flow coverage.");
        const target = resolveCall(node.expression, declaration.path, byName, imports);
        if (target) {
          const evidence = sourceEvidence(declaration.sourceFile, declaration.path, node, declaration.symbol);
          relationships.push({
            id: edgeId("call", declaration.symbol, target.symbol, ++edgeSequence),
            kind: "call",
            from: declaration.reference,
            to: target,
            certainty: "observed",
            evidence: [evidence],
          });
          for (const argument of node.arguments) {
            if (!ts.isIdentifier(argument)) { if (!ts.isLiteralExpression(argument)) dataReasons.add("Complex call arguments are not fully traced."); continue; }
            const variable = localVariables.get(argument.text);
            if (!variable) continue;
            relationships.push({
              id: edgeId("data", variable.symbol, target.symbol, ++edgeSequence),
              kind: "data-flow",
              from: variable,
              to: target,
              certainty: "observed",
              evidence: [sourceEvidence(declaration.sourceFile, declaration.path, argument, declaration.symbol)],
            });
          }
        } else if (!(ts.isIdentifier(node.expression) && ["require"].includes(node.expression.text))) {
          unresolvedCallReasons.add(`Unresolved call at ${declaration.path}:${declaration.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}.`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent)) {
        const property = sourceReference(declaration.sourceFile, declaration.path, node, `${declaration.symbol}.${node.name.text}`);
        const written = ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        relationships.push({
          id: edgeId(written ? "write" : "read", declaration.symbol, property.symbol, ++edgeSequence),
          kind: written ? "write" : "read",
          from: written ? declaration.reference : property,
          to: written ? property : declaration.reference,
          certainty: "observed",
          evidence: [sourceEvidence(declaration.sourceFile, declaration.path, node, property.symbol)],
        });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const variable = sourceReference(declaration.sourceFile, declaration.path, node.name, `${declaration.symbol}.${node.name.text}`);
        localVariables.set(node.name.text, variable);
        if (node.initializer && ts.isCallExpression(node.initializer)) {
          const target = resolveCall(node.initializer.expression, declaration.path, byName, imports);
          if (target) {
            relationships.push({
              id: edgeId("data", target.symbol, variable.symbol, ++edgeSequence),
              kind: "data-flow",
              from: target,
              to: variable,
              certainty: "observed",
              evidence: [sourceEvidence(declaration.sourceFile, declaration.path, node.initializer, declaration.symbol)],
            });
          }
        }
      }
    });
  }

  const changed = changedRanges(input.sanitizedDiff);
  const changedKeys = new Set(declarations.filter((declaration) => {
    const ranges = changed.get(declaration.path) ?? [];
    const start = declaration.reference.startLine ?? 0;
    const end = declaration.reference.endLine ?? start;
    return ranges.some((range) => start <= range.end && end >= range.start);
  }).map((declaration) => declaration.key));
  const impacted = transitiveCallers(changedKeys, relationships, byKey);
  const parseReasons = [...sourceFiles.values()].flatMap((sourceFile) => ((sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0 ? [`Parse diagnostics in ${sourceFile.fileName} prevent complete analysis.`] : []);
  const changedWithoutDeclaration = [...changed.entries()].flatMap(([changedPath, ranges]) => {
    if (!SUPPORTED_SOURCE.test(changedPath)) return [];
    const declarationsForPath = declarations.filter((declaration) => declaration.path === changedPath);
    return ranges
      .filter((range) => !declarationsForPath.some((declaration) => {
        const start = declaration.reference.startLine ?? 0;
        const end = declaration.reference.endLine ?? start;
        return start <= range.end && end >= range.start;
      }))
      .map((range) => `${changedPath}:${range.start}${range.end === range.start ? "" : `-${range.end}`}`);
  });
  const ordinaryFlowReasons = collectUnsupportedOrdinaryFlowReasons(sourceFiles);
  const sharedReasons = [...dynamicReasons, ...parseReasons, ...ordinaryFlowReasons];
  if (unsupportedChanged.length > 0) sharedReasons.push(`Unsupported changed source: ${unsupportedChanged.join(", ")}`);
  if (input.omittedSources?.length) sharedReasons.push(`Source omitted by analysis limits: ${input.omittedSources.join(", ")}`);
  if (changedWithoutDeclaration.length > 0) sharedReasons.push(`Changed range outside analyzable declarations: ${changedWithoutDeclaration.join(", ")}`);
  const callReasons = [...sharedReasons, ...unresolvedCallReasons];
  const dataCoverageReasons = [...new Set([...sharedReasons, ...unresolvedCallReasons, ...dataReasons])];
  const callCoverage = callReasons.length === 0 ? "complete" : "partial";
  const dataCoverage = dataCoverageReasons.length === 0 ? "complete" : "partial";

  return identifySemanticReview({
    ...structural.artifact,
    analysis: { engine: "veil-typescript-flow", version: "1.0.0", deterministic: true },
    impact: {
      coverage: { callFlow: callCoverage, dataFlow: dataCoverage, reasons: [...new Set([...callReasons, ...dataCoverageReasons])] },
      relationships,
      impactedSymbols: impacted,
      risk: impacted.length > 5 ? "high" : impacted.length > 0 ? "medium" : relationships.length > 0 ? "low" : "unknown",
    },
  });
}

function collectUnsupportedOrdinaryFlowReasons(sourceFiles: Map<string, ts.SourceFile>): string[] {
  const reasons = new Set<string>();
  const callableNames = new Set<string>();
  for (const sourceFile of sourceFiles.values()) {
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) callableNames.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) callableNames.add(node.name.text);
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }
  for (const sourceFile of sourceFiles.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        if (node.parameters.length > 0) reasons.add("Function parameter flow is not fully modeled.");
        if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) reasons.add("Return-value flow is not fully modeled.");
      }
      if (ts.isReturnStatement(node) && node.expression) reasons.add("Return-value flow is not fully modeled.");
      if (ts.isVariableDeclaration(node)) {
        if (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name)) reasons.add("Destructuring flow is not fully modeled.");
        if (node.initializer && (ts.isIdentifier(node.initializer) || ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer))) {
          reasons.add("Alias flow is not fully modeled.");
        }
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        reasons.add("Ordinary assignment flow is not fully modeled.");
        if (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left)) reasons.add("Destructuring flow is not fully modeled.");
        if (ts.isIdentifier(node.right) || ts.isPropertyAccessExpression(node.right) || ts.isElementAccessExpression(node.right)) reasons.add("Alias flow is not fully modeled.");
      }
      if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) reasons.add("Ordinary assignment flow is not fully modeled.");
      if (ts.isPostfixUnaryExpression(node)) reasons.add("Ordinary assignment flow is not fully modeled.");
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) reasons.add("Member-call flow is not fully modeled.");
        if (node.arguments.some((argument) => ts.isArrowFunction(argument)
          || ts.isFunctionExpression(argument)
          || (ts.isIdentifier(argument) && callableNames.has(argument.text)))) reasons.add("Callback flow is not fully modeled.");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...reasons];
}

function collectDeclarations(sourceFiles: Map<string, ts.SourceFile>): DeclarationRecord[] {
  const declarations: DeclarationRecord[] = [];
  for (const [sourcePath, sourceFile] of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const sourceScoped = ts.isSourceFile(node.parent);
        add(node.name.text, node, sourceScoped ? "source" : "nested", sourceScoped ? exportedNames(node, node.name.text) : [], sourceScoped ? undefined : node.parent);
      }
      else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) add(node.name.text, node, "member", []);
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const statement = node.parent.parent;
        const sourceScoped = ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
        add(node.name.text, node.initializer, sourceScoped ? "source" : "nested", sourceScoped ? exportedNames(statement, node.name.text) : [], sourceScoped ? undefined : nearestLexicalScope(node));
      }
      ts.forEachChild(node, visit);
    };
    const add = (symbol: string, node: ts.FunctionLikeDeclaration, scope: DeclarationRecord["scope"], names: string[], lexicalScope?: ts.Node) => {
      const reference = sourceReference(sourceFile, sourcePath, node, symbol);
      declarations.push({
        key: declarationIdentity(reference),
        path: sourcePath,
        symbol,
        scope,
        exportedNames: names,
        ...(lexicalScope === undefined ? {} : { lexicalScope }),
        sourceFile,
        node,
        reference,
      });
    };
    visit(sourceFile);
  }
  return declarations;
}

function indexDeclarationsByName(declarations: DeclarationRecord[]): Map<string, DeclarationRecord[]> {
  const index = new Map<string, DeclarationRecord[]>();
  for (const declaration of declarations) {
    const key = declarationKey(declaration.path, declaration.symbol);
    const matches = index.get(key) ?? [];
    matches.push(declaration);
    index.set(key, matches);
  }
  return index;
}

function exportedNames(node: ts.Node, symbol: string): string[] {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [symbol] : [];
}

function nearestLexicalScope(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) return current;
  }
  return undefined;
}

function collectImports(sourceFiles: Map<string, ts.SourceFile>, sources: Map<string, string>): Map<string, Map<string, ImportBinding>> {
  const imports = new Map<string, Map<string, ImportBinding>>();
  for (const [sourcePath, sourceFile] of sourceFiles) {
    const bindings = new Map<string, ImportBinding>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
      const targetPath = resolveModulePath(sourcePath, statement.moduleSpecifier.text, sources);
      const clause = statement.importClause;
      if (clause.name) bindings.set(clause.name.text, { targetPath, importedName: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          bindings.set(element.name.text, { targetPath, importedName: element.propertyName?.text ?? element.name.text });
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.set(clause.namedBindings.name.text, { targetPath, importedName: "*" });
      }
    }
    imports.set(sourcePath, bindings);
  }
  return imports;
}

function resolveCall(
  expression: ts.LeftHandSideExpression,
  sourcePath: string,
  declarations: Map<string, DeclarationRecord[]>,
  imports: Map<string, Map<string, ImportBinding>>,
): ImpactSymbolReference | undefined {
  if (ts.isIdentifier(expression)) {
    if (lexicalBindingShadows(expression)) return undefined;
    const local = uniqueSourceDeclaration(expression, declarations.get(declarationKey(sourcePath, expression.text)) ?? []);
    if (local) return local.reference;
    const binding = imports.get(sourcePath)?.get(expression.text);
    if (!binding?.targetPath) return undefined;
    return uniqueExportedDeclaration(declarations, binding.targetPath, binding.importedName)?.reference;
  }
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (ts.isIdentifier(expression.expression)) {
    if (lexicalBindingShadows(expression.expression)) return undefined;
    const binding = imports.get(sourcePath)?.get(expression.expression.text);
    if (binding?.targetPath && binding.importedName === "*") {
      return uniqueExportedDeclaration(declarations, binding.targetPath, expression.name.text)?.reference;
    }
  }
  // A matching property name does not prove receiver identity. Resolving
  // service.save() to the only bare `save` declaration in the workspace would
  // fabricate an edge; member calls remain unresolved without namespace-import
  // or future type-checker evidence.
  return undefined;
}

function lexicalBindingShadows(expression: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = expression.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)
      && current.parameters.some((parameter) => bindingContains(parameter.name, expression.text))) return true;
    if (ts.isBlock(current) || ts.isModuleBlock(current)) {
      for (const statement of current.statements) {
        if (ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some((declaration) => bindingContains(declaration.name, expression.text))) return true;
        if (ts.isClassDeclaration(statement) && statement.name?.text === expression.text) return true;
      }
    }
    if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current))
      && current.initializer
      && ts.isVariableDeclarationList(current.initializer)
      && current.initializer.declarations.some((declaration) => bindingContains(declaration.name, expression.text))) return true;
    if (ts.isCatchClause(current) && current.variableDeclaration
      && bindingContains(current.variableDeclaration.name, expression.text)) return true;
  }
  return false;
}

function bindingContains(name: ts.BindingName, identifier: string): boolean {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingContains(element.name, identifier));
}

function uniqueSourceDeclaration(expression: ts.Expression, candidates: DeclarationRecord[]): DeclarationRecord | undefined {
  if (candidates.some((candidate) => candidate.scope === "nested"
    && candidate.lexicalScope !== undefined
    && candidate.lexicalScope.getSourceFile() === expression.getSourceFile()
    && candidate.lexicalScope.getStart() <= expression.getStart()
    && candidate.lexicalScope.getEnd() >= expression.getEnd())) return undefined;
  const sourceScoped = candidates.filter((candidate) => candidate.scope === "source");
  return sourceScoped.length === 1 ? sourceScoped[0] : undefined;
}

function uniqueExportedDeclaration(
  declarations: Map<string, DeclarationRecord[]>,
  sourcePath: string,
  exportedName: string,
): DeclarationRecord | undefined {
  const candidates = [...declarations.values()].flat().filter((candidate) =>
    candidate.path === sourcePath
      && candidate.scope === "source"
      && candidate.exportedNames.includes(exportedName),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function transitiveCallers(
  changedKeys: Set<string>,
  relationships: ImpactRelationship[],
  declarations: Map<string, DeclarationRecord>,
): ImpactSymbolReference[] {
  const keyForReference = declarationIdentity;
  const reverse = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (relationship.kind !== "call") continue;
    const target = keyForReference(relationship.to);
    const callers = reverse.get(target) ?? new Set<string>();
    callers.add(keyForReference(relationship.from));
    reverse.set(target, callers);
  }
  const visited = new Set(changedKeys);
  const queue = [...changedKeys];
  const impacted: ImpactSymbolReference[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const caller of reverse.get(key) ?? []) {
      if (visited.has(caller)) continue;
      visited.add(caller);
      queue.push(caller);
      const declaration = declarations.get(caller);
      if (declaration) impacted.push(declaration.reference);
    }
  }
  return impacted;
}

function visitFunctionBody(node: ts.FunctionLikeDeclaration, visitor: (node: ts.Node) => void): void {
  if (!node.body) return;
  const visit = (child: ts.Node) => {
    visitor(child);
    if (child !== node.body && ts.isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node.body);
}

function sourceReference(sourceFile: ts.SourceFile, sourcePath: string, node: ts.Node, symbol: string): ImpactSymbolReference {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { path: sourcePath, symbol, startLine: start, endLine: end };
}

function sourceEvidence(sourceFile: ts.SourceFile, sourcePath: string, node: ts.Node, symbol: string): ReviewEvidence {
  const reference = sourceReference(sourceFile, sourcePath, node, symbol);
  return {
    kind: "source-range",
    path: reference.path,
    symbol: reference.symbol,
    startLine: reference.startLine!,
    endLine: reference.endLine!,
  };
}

function resolveModulePath(sourcePath: string, specifier: string, sources: Map<string, string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const withoutExtension = base.replace(/\.(?:mjs|cjs|js|jsx|ts|tsx)$/i, "");
  for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    const candidate = `${withoutExtension}${extension}`;
    if (sources.has(candidate)) return candidate;
  }
  for (const extension of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = `${withoutExtension}/index${extension}`;
    if (sources.has(candidate)) return candidate;
  }
  return undefined;
}

function changedPaths(diff: string): string[] {
  return [...changedRanges(diff).keys()];
}

function changedRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  let currentPath: string | undefined;
  for (const line of diff.split("\n")) {
    const target = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
    if (target) { currentPath = target[1] ? normalizeSourcePath(target[1]) : undefined; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!currentPath || !hunk) continue;
    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? 1);
    const ranges = result.get(currentPath) ?? [];
    ranges.push({ start, end: Math.max(start, start + count - 1) });
    result.set(currentPath, ranges);
  }
  return result;
}

function declarationKey(sourcePath: string, symbol: string): string {
  return `${sourcePath}#${symbol}`;
}

function declarationIdentity(reference: ImpactSymbolReference): string {
  return `${declarationKey(reference.path, reference.symbol)}@${reference.startLine ?? 0}:${reference.endLine ?? 0}`;
}

function edgeId(kind: string, from: string, to: string, sequence: number): string {
  const slug = `${kind}-${from}-${to}-${sequence}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 128);
}

function normalizeSourcePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function scriptKindFor(sourcePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(sourcePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(sourcePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(sourcePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
