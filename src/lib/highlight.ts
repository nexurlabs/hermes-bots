/**
 * Syntax highlighting for code blocks: highlight.js core with the languages bots write most.
 * Its output is HTML made only of `<span class="hljs-…">` around text it has escaped itself.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, markdown, powershell, python, rust, shell, sql, typescript, xml, yaml }

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language)
}

hljs.registerAliases(['toml'], { languageName: 'ini' })
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' })
hljs.registerAliases(['zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' })

/** Too long to guess the language of on every streamed token. */
const AUTO_LIMIT = 4000

/** Highlighted HTML, or null to show the code as plain text. */
export function highlight(code: string, lang: string): null | string {
  const name = lang.toLowerCase()

  try {
    if (name && hljs.getLanguage(name)) {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
    }

    if (!name && code.length <= AUTO_LIMIT) {
      const guess = hljs.highlightAuto(code)

      return guess.relevance >= 5 ? guess.value : null
    }
  } catch {
    /* plain text */
  }

  return null
}

/** The name to show on a code block: what the bot wrote, tidied. */
export function languageLabel(lang: string): string {
  const name = lang.toLowerCase()
  const known: Record<string, string> = { js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', jsx: 'JSX', py: 'Python', python: 'Python', sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell', console: 'Console', json: 'JSON', yaml: 'YAML', yml: 'YAML', html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', sql: 'SQL', go: 'Go', rust: 'Rust', rs: 'Rust', java: 'Java', c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', diff: 'Diff', md: 'Markdown', markdown: 'Markdown', toml: 'TOML', ini: 'INI', dockerfile: 'Dockerfile', powershell: 'PowerShell', ps1: 'PowerShell', rb: 'Ruby', ruby: 'Ruby', php: 'PHP', kt: 'Kotlin', kotlin: 'Kotlin', swift: 'Swift', math: 'Math', latex: 'LaTeX', tex: 'TeX', text: 'Text', txt: 'Text', plaintext: 'Text' }

  return known[name] || lang
}
