#!/usr/bin/env node
// Builds the app's file icon sprite from Catppuccin's icons (MIT,
// https://github.com/catppuccin/vscode-icons), as packaged for Iconify:
//
//   npm pack @iconify-json/catppuccin@1.2.17
//   tar xzf iconify-json-catppuccin-1.2.17.tgz
//   node scripts/build-file-icon-sprite.mjs package/icons.json
//
// The icons come in Catppuccin Macchiato. Each of its colors becomes a CSS
// variable (--ctp-*, set in packages/app/src/index.css) with that color as
// fallback, so the icons take the flavor that suits the app's theme.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const macchiato = {
  "#cad3f5": "text",
  "#8087a2": "overlay1",
  "#f4dbd6": "rosewater",
  "#f0c6c6": "flamingo",
  "#f5bde6": "pink",
  "#c6a0f6": "mauve",
  "#ed8796": "red",
  "#ee99a0": "maroon",
  "#f5a97f": "peach",
  "#eed49f": "yellow",
  "#a6da95": "green",
  "#8bd5ca": "teal",
  "#91d7e3": "sky",
  "#7dc4e4": "sapphire",
  "#8aadf4": "blue",
  "#b7bdf8": "lavender",
};

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/build-file-icon-sprite.mjs <icons.json>");
  process.exit(1);
}

const set = JSON.parse(readFileSync(source, "utf8"));
const output = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/app/src/components/file-icons/sprite.svg",
);

const symbols = Object.entries(set.icons)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, icon]) => {
    const width = icon.width ?? set.width ?? 16;
    const height = icon.height ?? set.height ?? 16;
    return `<symbol id="${name}" viewBox="0 0 ${width} ${height}">${themed(icon.body)}</symbol>`;
  });

writeFileSync(
  output,
  [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    "<!-- Catppuccin Icons (MIT), https://github.com/catppuccin/vscode-icons. Built by scripts/build-file-icon-sprite.mjs. -->",
    "<defs>",
    ...symbols,
    "</defs>",
    "</svg>",
    "",
  ].join("\n"),
);
console.log(`${symbols.length} icons written to ${output}`);

// Palette colors set as attributes move to a style, where a variable can
// replace them.
function themed(body) {
  return body.replace(
    /<([a-zA-Z]+)((?:\s+[^\s=>]+="[^"]*")*)\s*(\/?)>/g,
    (tag, element, attributes, selfClosing) => {
      const styles = [];
      let rest = attributes.replace(
        /\s+(fill|stroke)="(#[0-9a-fA-F]{3,6})"/g,
        (attribute, property, color) => {
          const name = macchiato[color.toLowerCase()];
          if (!name) return attribute;
          styles.push(`${property}:var(--ctp-${name},${color})`);
          return "";
        },
      );
      if (!styles.length) return tag;
      const style = styles.join(";");
      rest = /\sstyle="/.test(rest)
        ? rest.replace(/\sstyle="/, ` style="${style};`)
        : `${rest} style="${style}"`;
      return `<${element}${rest}${selfClosing ? "/" : ""}>`;
    },
  );
}
