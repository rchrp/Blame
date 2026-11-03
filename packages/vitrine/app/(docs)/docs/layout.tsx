import { DocsLayout } from "fumadocs-ui/layouts/notebook";

import { docsLayoutOptions } from "@/lib/docs/layout";
import { docsSource } from "@/lib/docs/source";

export default function DocsSectionLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { nav, ...options } = docsLayoutOptions();
  return (
    <DocsLayout
      tree={docsSource.getPageTree()}
      {...options}
      nav={{ ...nav, mode: "top" }}
      themeSwitch={{ mode: "light-dark" }}
    >
      {children}
    </DocsLayout>
  );
}
