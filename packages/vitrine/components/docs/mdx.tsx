import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

// The components every docs page can use: Fumadocs' defaults (callouts,
// cards, code blocks…) and steps, plus any given override.
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
