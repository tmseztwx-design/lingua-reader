// 生成可部署的单文件函数。
//
// 平台部署器只打包 supabase/functions/<name>/index.ts 这一个文件（同目录或上层的其它 .ts
// 都不会被带上），所以每个函数在磁盘上必须自包含。唯一可读源是：
//   supabase/functions/src/<name>.ts  与  supabase/functions/_shared/*.ts
// 本脚本把它们内联成 <name>/index.ts。改完源文件后运行：pnpm bundle:functions
import fs from "node:fs";
import path from "node:path";

const NL = String.fromCharCode(10);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const functionsDir = path.join(root, "supabase", "functions");
const sharedDir = path.join(functionsDir, "_shared");
const srcDir = path.join(functionsDir, "src");

const sharedFiles = ["cloud.ts", "ocr-core.ts"];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// 收集一个共享文件导出的名字与类型。
function exportsOf(code) {
  const values = new Set();
  const types = new Map();
  for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) values.add(match[1]);
  for (const match of code.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) values.add(match[1]);
  for (const match of code.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);/g)) {
    types.set(match[1], `type ${match[1]} = ${match[2]};`);
  }
  const interfacePattern = new RegExp("export\\s+interface\\s+(\\w+)\\s*\\{([\\s\\S]*?)" + NL + "\\}", "g");
  for (const match of code.matchAll(interfacePattern)) {
    types.set(match[1], `interface ${match[1]} {${match[2]}${NL}}`);
  }
  return { values, types };
}

function stripModuleSyntax(code) {
  return code
    .replace(/^import[\s\S]*?from\s+"[^"]+";?\s*$/gm, "")
    .replace(/^export\s+/gm, "")
    .trim();
}

function remoteImportsOf(code) {
  return [...code.matchAll(/^import\s+[\s\S]*?from\s+"(https?:[^"]+)";?$/gm)].map((match) => match[0]);
}

function sharedImportsOf(code) {
  const names = { values: [], types: [] };
  for (const match of code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\.\/_shared\/[^"]+";?$/gm)) {
    match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        const isType = item.startsWith("type ");
        const name = item.replace(/^type\s+/, "").trim();
        (isType ? names.types : names.values).push(name);
      });
  }
  return names;
}

function indent(code) {
  return code
    .split(NL)
    .map((line) => (line ? "  " + line : line))
    .join(NL);
}

const sharedCode = sharedFiles.map((file) => read(path.join(sharedDir, file)));
const sharedExports = { values: new Set(), types: new Map() };
sharedCode.forEach((code) => {
  const found = exportsOf(code);
  found.values.forEach((name) => sharedExports.values.add(name));
  found.types.forEach((value, key) => sharedExports.types.set(key, value));
});

const functions = fs
  .readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => name.replace(/\.ts$/, ""));

let built = 0;
for (const name of functions) {
  const source = read(path.join(srcDir, `${name}.ts`));
  const imports = sharedImportsOf(source);
  const neededValues = [...new Set(imports.values.filter((item) => sharedExports.values.has(item)))];
  const neededTypes = [...imports.types, ...imports.values.filter((item) => sharedExports.types.has(item))]
    .map((item) => (sharedExports.types.has(item) ? sharedExports.types.get(item) : null))
    .filter(Boolean);

  const usedShared = sharedFiles.filter((file) => source.includes("_shared/" + file));
  const usedCode = usedShared.map((file) => sharedCode[sharedFiles.indexOf(file)]);
  const usedExports = new Set();
  usedCode.forEach((code) => { exportsOf(code).values.forEach((name) => usedExports.add(name)); });
  const importLines = [...remoteImportsOf(source), ...usedCode.flatMap(remoteImportsOf)];
  const seenUrls = new Set();
  const remoteImports = importLines.filter((line) => { const url = (line.match(/"(https?:[^"]+)"/) || [])[1] || line; if (seenUrls.has(url)) return false; seenUrls.add(url); return true; });
  const body = source
    .replace(/^import\s*\{[^}]*\}\s*from\s*"\.\.\/_shared\/[^"]+";?\s*$/gm, "")
    .replace(/^import\s[\s\S]*?from\s"https?:[^"]+";?\s*$/gm, "")
    .trim();

  const output = [
    `// 由 scripts/bundle-functions.mjs 从 supabase/functions/src/${name}.ts 生成，请勿直接编辑。`,
    "// 修改源文件后运行：pnpm bundle:functions",
    "",
    ...remoteImports,
    "",
    "// ---- 共享模块（supabase/functions/_shared 内联，平台只部署单文件） ----",
    "const __shared = (() => {",
    ...usedCode.map((code) => indent(stripModuleSyntax(code))),
    `  return { ${[...usedExports].join(", ")} };`,
    "})();",
    neededValues.length ? `const { ${neededValues.join(", ")} } = __shared;` : "",
    ...neededTypes,
    "",
    "// ---- 函数实现 ----",
    body,
    "",
  ].join(NL);

  const target = path.join(functionsDir, name, "index.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
  built += 1;
  console.log(`${name}: ${output.split(NL).length} 行 -> supabase/functions/${name}/index.ts`);
}

console.log(`完成：${built} 个函数已生成可部署的单文件版本。`);
