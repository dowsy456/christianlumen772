'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const types = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.mp4':'video/mp4', '.webm':'video/webm', '.pdf':'application/pdf', '.txt':'text/plain', '.html':'text/html', '.htm':'text/html', '.zip':'application/zip' };
async function readClipboardFiles(limit, { platform = process.platform, executeImpl = execute, fsImpl = fs, maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (platform !== 'win32') return [];
  const count = Number.isInteger(limit) ? Math.max(0, Math.min(12, limit)) : 12;
  const maximumBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : MAX_FILE_BYTES;
  if (!count) return [];
  // Read the Windows file-drop clipboard only following an explicit app paste.
  // No renderer-provided paths or commands are accepted.
  const nativeRoot = __dirname.replace(/([\\/])app\.asar(?=[\\/]|$)/i, '$1app.asar.unpacked');
  const helper = path.join(nativeRoot, 'helpers', 'game-process-helper.exe');
  const { stdout } = await executeImpl(helper, ['--clipboard-files'], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  const value = JSON.parse(stdout.trim() || '[]');
  const paths = (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string');
  if (paths.length > count) throw new Error(`You can attach ${count} more file${count === 1 ? '' : 's'} to this message (12 total).`);
  const result = [];
  for (const filename of paths) {
    const stat = await fsImpl.stat(filename);
    if (!stat.isFile()) throw new Error('Paste individual files; folders cannot be attached.');
    if (stat.size > maximumBytes) throw new Error(`${path.basename(filename)} exceeds the ${maximumBytes / (1024 * 1024)} MB file limit.`);
    const buffer = await fsImpl.readFile(filename);
    result.push({ name: path.basename(filename), type: types[path.extname(filename).toLowerCase()] || 'application/octet-stream', data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) });
  }
  return result;
}
module.exports = { readClipboardFiles };
