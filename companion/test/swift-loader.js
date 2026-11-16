import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolves `import source from './menubar.swift'` to the file next to the importer. */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('.swift')) return nextResolve(specifier, context);
  const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
  const file = path.resolve(path.dirname(parent), specifier);
  return { url: pathToFileURL(file).href, shortCircuit: true };
}

/** Serves a Swift file as a module whose default export is its source text. */
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.swift')) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  return {
    format: 'module',
    source: `export default ${JSON.stringify(source)};\n`,
    shortCircuit: true,
  };
}
