const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('src/renderer/index.html');
const app = read('src/renderer/app.js');
const css = read('src/renderer/styles.css');
const issues = [];

// Every literal ID queried by the renderer must be present in the document.
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const queried = new Set([...app.matchAll(/querySelector\(['"]#([\w-]+)['"]\)/g)].map((match) => match[1]));
for (const id of queried) {
  if (!ids.has(id) && id !== 'storeTagButton' && id !== 'storeTagMenu' && id !== 'storeTagItems' && id !== 'clearStoreTag') {
    issues.push(`Renderer queries #${id}, but index.html does not define it.`);
  }
}

// A paused animation with a transparent first frame makes otherwise valid UI disappear.
const pausedSelectors = [...css.matchAll(/([^{}]+)\{[^{}]*animation-play-state:\s*paused[^{}]*\}/gs)]
  .map((match) => match[1].trim());
if (pausedSelectors.length && !/classList\.add\(['"]has-entered['"]\)/.test(app)) {
  issues.push(`Paused entrance animations have no activation path: ${pausedSelectors.join(', ')}.`);
}

const libraryPath = path.join(process.env.APPDATA || '', 'chrona-game-launcher', 'library.json');
if (fs.existsSync(libraryPath)) {
  const data = fs.readFileSync(libraryPath);
  if (data.includes(0)) issues.push('The active library.json contains null bytes.');
  else {
    try {
      const library = JSON.parse(data);
      if (!Array.isArray(library.games)) issues.push('The active library.json does not contain a games array.');
      else console.log(`Library audit: ${library.games.length} games; JSON is valid.`);
    } catch (error) {
      issues.push(`The active library.json cannot be parsed: ${error.message}`);
    }
  }
} else console.log('Library audit: no local library found; skipped.');

console.log(`DOM audit: ${ids.size} IDs defined; ${queried.size} literal IDs queried.`);
if (issues.length) {
  console.error(`AUDIT FAILED (${issues.length} issue${issues.length === 1 ? '' : 's'}):`);
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else console.log('AUDIT PASSED');
