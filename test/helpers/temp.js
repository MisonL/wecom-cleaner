import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export async function makeTempDir(prefix = 'wecom-cleaner-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function ensureFile(filePath, content = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (Buffer.isBuffer(content)) {
    await fs.writeFile(filePath, content);
    return;
  }
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function removeDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
}

export function toBase64Utf8(text) {
  return Buffer.from(String(text || ''), 'utf-8').toString('base64');
}
