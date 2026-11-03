import { createFromSource } from "fumadocs-core/search/server";

import { docsSource } from "@/lib/docs/source";

// The docs search box (Fumadocs' built-in search): the index is built from
// the pages on this server, with no outside service.
export const { GET } = createFromSource(docsSource, { language: "english" });
