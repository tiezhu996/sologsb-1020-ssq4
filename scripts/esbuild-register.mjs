// 极简 loader：用 esbuild 把 .ts 转成 ESM 供 node 冒烟测试，并补全省略的扩展名。
import { transformSync } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch {
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, { loader: 'ts', format: 'esm' });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
