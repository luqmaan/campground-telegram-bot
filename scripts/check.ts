const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const files = process.argv.slice(2);

if (!files.length) {
  console.error('Usage: node scripts/check.ts <file...>');
  process.exit(1);
}

for (const file of files) {
  const absolutePath = path.resolve(file);
  const source = fs.readFileSync(absolutePath, 'utf8');
  try {
    const stripped = stripTypeScriptTypes(source);
    new vm.Script(stripped, { filename: absolutePath });
  } catch (error) {
    console.error(`Syntax check failed for ${file}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

console.log(`Checked ${files.length} TypeScript files.`);
