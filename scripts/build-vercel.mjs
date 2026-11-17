import { copyFile, mkdir, rm } from 'node:fs/promises';

// Publish only browser assets; server source, traces, and secrets stay outside public/.
await rm('public', { recursive: true, force: true });
await mkdir('public');
for (const [source, destination] of [
  ['web/index.html', 'index.html'],
  ['web/style.css', 'style.css'],
  ['dist/web/app.js', 'app.js'],
]) {
  await copyFile(source, `public/${destination}`);
}
