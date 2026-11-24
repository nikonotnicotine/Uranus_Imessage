// 把 docs 下的 markdown 渲染成 HTML 再用 Chrome headless 打成 PDF
// 用法：node scripts/md-to-pdf.mjs <输入.md> [更多.md ...]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { marked } from 'marked';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('找不到 Chrome 或 Edge，没法打 PDF');

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
html { -webkit-print-color-adjust: exact; }
body {
  font-family: "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 10.5pt; line-height: 1.75; color: #1c1c1e; margin: 0;
}
h1 { font-size: 20pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
h2 {
  font-size: 14pt; margin: 22pt 0 8pt; padding-bottom: 4pt;
  border-bottom: 1px solid #d8d8dc; break-after: avoid;
}
h3 { font-size: 11.5pt; margin: 16pt 0 6pt; break-after: avoid; }
h1 + p { color: #6a6a6e; margin-top: 0; }
p, li { orphans: 2; widows: 2; }
ul { padding-left: 18pt; }
li { margin: 3pt 0; }
code {
  font-family: Consolas, "Cascadia Mono", monospace; font-size: 9pt;
  background: #f2f2f5; padding: 1pt 3pt; border-radius: 3px;
}
pre {
  background: #f7f7f9; border: 1px solid #e3e3e7; border-radius: 5px;
  padding: 8pt 10pt; overflow-wrap: break-word; white-space: pre-wrap;
  break-inside: avoid; font-size: 8.5pt; line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: inherit; }
hr { border: none; border-top: 1px solid #e3e3e7; margin: 18pt 0; }
strong { color: #000; }
a { color: #0a58ca; text-decoration: none; word-break: break-all; }
blockquote { margin: 0; padding-left: 12pt; border-left: 3px solid #d8d8dc; color: #4a4a4e; }
`;

marked.setOptions({ mangle: false, headerIds: false });

for (const input of process.argv.slice(2)) {
  const src = resolve(input);
  const md = readFileSync(src, 'utf8');
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? basename(src)).trim();
  const stem = basename(src).replace(/\.md$/i, '');
  const outDir = join(dirname(src), 'build');
  mkdirSync(outDir, { recursive: true });

  const html = join(outDir, `${stem}.html`);
  const pdf = join(outDir, `${stem}.pdf`);
  writeFileSync(
    html,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
      `<title>${title}</title><style>${CSS}</style>${marked.parse(md)}</html>`,
    'utf8',
  );

  execFileSync(CHROME, [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdf}`,
    `file:///${html.replace(/\\/g, '/')}`,
  ], { stdio: 'inherit' });

  console.log(`✓ ${pdf}`);
}
