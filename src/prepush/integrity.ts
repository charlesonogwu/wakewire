/** Run by trusted image Node, never npm or candidate code. The manifest digest
 * stays in host memory, outside the candidate-writable volume. No Git content
 * filtering: this measures exact extracted bytes, permissions and existence.
 */
export const integrityScript = String.raw`
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, lstatSync } = require('node:fs');
const { resolve, sep } = require('node:path');
(async () => {
  const sha = process.argv[1];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('sha');
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', sha], { timeout: 30000, maxBuffer: 8*1024*1024 });
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(tree).split('\0').filter(Boolean);
  const manifest = createHash('sha256');
  const root = process.cwd();
  let bytes = 0;
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (!/^100(644|755) blob [a-f0-9]{40}$/.test(entry.slice(0, tab))) throw new Error('tree');
    const name = entry.slice(tab + 1);
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw new Error('path');
    const path = resolve(root, ...parts);
    if (!path.startsWith(root + sep)) throw new Error('path');
    for (let n = 1; n < parts.length; n++) {
      const directory = lstatSync(resolve(root, ...parts.slice(0, n)));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('directory');
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (bytes += info.size) > 1024*1024*1024) throw new Error('file');
    const content = createHash('sha256');
    for await (const chunk of createReadStream(path)) content.update(chunk);
    manifest.update(JSON.stringify([name, info.mode & 0o777, info.size, content.digest('hex')]));
  }
  process.stdout.write(manifest.digest('hex'));
})().catch(() => { process.exitCode = 1; });
`;
