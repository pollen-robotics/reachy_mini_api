#!/usr/bin/env node
// Flatten the Allure tree so the top level is the test file (like pytest's
// module-as-suite), instead of nesting everything under the `test/` directory.
//
// node:test's Allure reporter derives a `titlePath` from the file path relative
// to the project root (e.g. ["test", "visibility.test.mjs"]), and the awesome
// plugin builds its tree from that titlePath - hence the extra "test" parent.
// pytest instead emits a `suite` label (the module) and no titlePath, so its
// tree starts at the file. We mirror that here: drop the titlePath and add a
// `suite` label = the file's base name.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "allure-results";
const SUITE_LABELS = new Set(["parentSuite", "suite", "subSuite"]);

const fileSuiteName = (result) => {
  const fullName = result.fullName || "";
  // fullName looks like "<project>:test/visibility.test.mjs#<test name>".
  const match = fullName.match(/:([^#]+)#/) || fullName.match(/^([^#]+)#/);
  const relative = match ? match[1] : "";
  const base = relative.split("/").pop() || relative;
  return base.replace(/\.test\.(mjs|cjs|js|ts)$/i, "").replace(/\.(mjs|cjs|js|ts)$/i, "");
};

let patched = 0;
for (const file of readdirSync(dir)) {
  if (!file.endsWith("-result.json")) continue;
  const path = join(dir, file);
  const result = JSON.parse(readFileSync(path, "utf8"));

  result.titlePath = [];
  result.labels = result.labels || [];
  const hasSuite = result.labels.some((label) => SUITE_LABELS.has(label.name));
  const suite = fileSuiteName(result);
  if (!hasSuite && suite) {
    result.labels.push({ name: "suite", value: suite });
  }

  writeFileSync(path, JSON.stringify(result));
  patched += 1;
}

console.log(`allure-flatten: patched ${patched} result(s) in ${dir}`);
