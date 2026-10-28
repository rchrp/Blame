export function configurationName(name: string, path: string) {
  return (
    /^(\.babelrc|\.clang-format|\.clang-tidy|\.commitlintrc|\.credo\.exs|\.editorconfig|\.eslintrc|\.flake8|\.formatter\.exs|\.globalconfig|\.golangci|\.hlint|\.ocamlformat|\.php-cs-fixer|\.prettierrc|\.rspec|\.rubocop|\.scalafmt|\.standard|\.stylelintrc|\.stylua|\.swiftformat|\.swiftlint)/.test(
      name,
    ) ||
    /^(analysis_options|biome|checkstyle|clippy|clj-kondo|commitlint|cypress|dart_test|deny|detekt|directory\.build|eslint|hlint|jest|ktlint|lint-staged|mypy|nextest|phpcs|phpstan|phpunit|playwright|pmd|prettier|psalm|pytest|ruff|rustfmt|scalafmt|spotbugs|stylecop|stylelint|stylua|tox|tsconfig|vitest)/.test(
      name,
    ) ||
    path.includes("/.github/workflows/")
  );
}


export function nativeProjectEvidence(path: string) {
  return /(?:^|\/)(?:project\.yml|Project\.swift|Info\.plist|AndroidManifest\.xml|app\.json|app\.config\.[^/]+)$/.test(path) || /\.(?:xcodeproj\/project\.pbxproj|xcworkspace\/contents\.xcworkspacedata|xcscheme)$/.test(path);
}
