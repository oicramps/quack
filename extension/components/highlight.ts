import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import groovy from 'highlight.js/lib/languages/groovy';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import properties from 'highlight.js/lib/languages/properties';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { bash, css, diff, go, groovy, java, javascript, json, kotlin, markdown, properties, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

/** Fence tags and file extensions that differ from the language names above. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  patch: 'diff',
  kt: 'kotlin',
  kts: 'kotlin',
  gradle: 'groovy',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  plist: 'xml',
  scss: 'css',
  md: 'markdown',
  jsonc: 'json',
};

/** Picks a language from a fence tag ("ts") or a file name ("src/a.kt"). */
export function languageFor(lang?: string, file?: string): string | null {
  for (const candidate of [lang, file?.split('.').pop()]) {
    const name = candidate?.toLowerCase();
    if (!name) continue;
    const resolved = ALIASES[name] ?? name;
    if (hljs.getLanguage(resolved)) return resolved;
  }
  return null;
}

/** Highlighted HTML for the code; highlight.js escapes the code itself. */
export function highlight(code: string, language: string): string {
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
