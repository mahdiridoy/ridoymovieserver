const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'web');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const re2 = /export\s*\{([^}]+)\}/g;
  while ((m = re2.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  const reStar = /export\s*\*\s*from/g;
  const reexports = [];
  let s;
  while ((s = reStar.exec(src))) reexports.push(true);
  return { names, hasStar: reexports.length > 0 };
}

let failures = 0;
const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|([\w$]+)|\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(src))) {
    const [, defaultName, named, single, ns, spec] = m;
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      console.log(`MISSING FILE: ${path.relative(root, file)} -> ${spec}`);
      failures++;
      continue;
    }
    const exp = exportsOf(target);
    const wanted = [];
    if (defaultName) wanted.push({ name: defaultName, kind: 'default' });
    if (single) wanted.push({ name: single, kind: 'default' });
    if (ns) wanted.push({ name: ns, kind: 'ns' });
    if (named) {
      for (const part of named.split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (n) wanted.push({ name: n, kind: 'named' });
      }
    }
    for (const w of wanted) {
      if (w.kind === 'ns') continue;
      if (w.kind === 'named') {
        if (!exp.names.has(w.name)) {
          console.log(`MISSING EXPORT: ${w.name} not in ${spec} (imported by ${path.relative(root, file)})`);
          failures++;
        }
      } else {
        const hasDefault = /\bexport\s+default\b/.test(fs.readFileSync(target, 'utf8'));
        if (!hasDefault) {
          console.log(`MISSING DEFAULT EXPORT: ${spec} (imported by ${path.relative(root, file)})`);
          failures++;
        }
      }
    }
  }
}
console.log(`\n${files.length} files scanned, ${failures} problems`);
process.exit(failures ? 1 : 0);
