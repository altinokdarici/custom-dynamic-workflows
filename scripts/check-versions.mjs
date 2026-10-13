// Fails unless package.json and both plugin manifests carry the same version.
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const versions = {
  "package.json": read("package.json").version,
  ".claude-plugin/plugin.json": read(".claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json": read(".claude-plugin/marketplace.json").plugins.find(
    (p) => p.name === "custom-dynamic-workflows",
  )?.version,
};

if (new Set(Object.values(versions)).size !== 1) {
  console.error("Plugin versions differ:");
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}: ${version}`);
  process.exit(1);
}
console.log(`All manifests at ${versions["package.json"]}`);
