import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "evidence/context-before-patch.json");
const context = JSON.parse(await readFile(path, "utf8"));

console.log(`You are modifying a small JavaScript business module. Use only the supplied SDD context.

Task: ${context.task}

Applicable specifications:
${context.applicableSpecifications.map((item) => `${item.source}\n${item.excerpt}`).join("\n\n")}

Code locations:
${context.codeLocations.map((item) => `${item.source} [${item.symbols}]\n${item.excerpt}`).join("\n\n")}

Verification tests:
${context.verificationTests.map((item) => `${item.source}\n${item.excerpt}`).join("\n\n")}

Return only the complete replacement source for business/release_catalog.js. Do not change tests or specifications.`);
