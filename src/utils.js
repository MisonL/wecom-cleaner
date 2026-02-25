import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MONTH_RE } from './constants.js';

export function expandHome(rawPath) {
  if (!rawPath) {
    return rawPath;
  }
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export function inferDataRootFromProfilesRoot(rootDir) {
  const expanded = expandHome(rootDir);
  if (!expanded) {
    return null;
  }
  const normalized = path.resolve(expanded);
  const marker = `${path.sep}Documents${path.sep}Profiles`;
  const idx = normalized.lastIndexOf(marker);
  if (idx > 0) {
    return normalized.slice(0, idx);
  }
  const baseName = path.basename(normalized);
  const parentName = path.basename(path.dirname(normalized));
  if (baseName === 'Profiles' && parentName === 'Documents') {
    return path.resolve(normalized, '..', '..');
  }
  return null;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function decodeBase64Utf8(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  try {
    return Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

export function formatBytes(bytes) {
  const num = Number(bytes || 0);
  if (num < 1024) {
    return `${num}B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = num / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)}${units[idx]}`;
}

export function normalizeMonthKey(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const match = input.trim().match(MONTH_RE);
  if (!match?.groups) {
    return null;
  }
  const year = Number(match.groups.y);
  const month = Number(match.groups.m);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

export function monthToSortableNumber(monthKey) {
  const normalized = normalizeMonthKey(monthKey);
  if (!normalized) {
    return Number.NaN;
  }
  const [y, m] = normalized.split('-').map(Number);
  return y * 100 + m;
}

export function sortMonthKeys(values, order = 'asc') {
  const list = [...new Set(values.map((x) => normalizeMonthKey(x)).filter(Boolean))];
  list.sort((a, b) => monthToSortableNumber(a) - monthToSortableNumber(b));
  return order === 'desc' ? list.reverse() : list;
}

export function monthByDaysBefore(days) {
  const now = new Date();
  const past = new Date(now.getTime() - Number(days || 0) * 24 * 3600 * 1000);
  return `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function compareMonthKey(a, b) {
  return monthToSortableNumber(a) - monthToSortableNumber(b);
}

export function shortId(fullId) {
  if (!fullId) {
    return '-';
  }
  return String(fullId).slice(0, 8);
}

function charWidth(ch) {
  if (!ch) {
    return 0;
  }
  const code = ch.codePointAt(0);
  if (!code) {
    return 0;
  }
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text) {
  return Array.from(String(text ?? '')).reduce((acc, ch) => acc + charWidth(ch), 0);
}

export function trimToWidth(text, width) {
  const input = String(text ?? '');
  if (width <= 0) {
    return '';
  }
  if (stringWidth(input) <= width) {
    return input;
  }
  const suffix = width >= 3 ? '...' : '';
  const target = width - stringWidth(suffix);
  if (target <= 0) {
    return suffix.slice(0, width);
  }
  let used = 0;
  let out = '';
  for (const ch of Array.from(input)) {
    const w = charWidth(ch);
    if (used + w > target) {
      break;
    }
    out += ch;
    used += w;
  }
  return `${out}${suffix}`;
}

export function padToWidth(text, width) {
  const clipped = trimToWidth(text, width);
  const padSize = Math.max(0, width - stringWidth(clipped));
  return `${clipped}${' '.repeat(padSize)}`;
}

export function renderTable(headers, rows, options = {}) {
  const terminalWidth = Number(options.terminalWidth || process.stdout.columns || 120);
  const separator = ' | ';
  const minColWidth = Number(options.minColWidth || 6);

  const colCount = headers.length;
  const widths = headers.map((header, col) => {
    let max = stringWidth(header);
    for (const row of rows) {
      max = Math.max(max, stringWidth(row[col] ?? ''));
    }
    return Math.min(Math.max(max, minColWidth), 46);
  });

  const separatorWidth = separator.length * (colCount - 1);
  const sum = () => widths.reduce((acc, w) => acc + w, 0) + separatorWidth;

  while (sum() > terminalWidth && widths.some((w) => w > minColWidth)) {
    let maxIdx = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[maxIdx]) {
        maxIdx = i;
      }
    }
    widths[maxIdx] = Math.max(minColWidth, widths[maxIdx] - 1);
  }

  const drawRow = (row) => row.map((cell, idx) => padToWidth(cell, widths[idx])).join(separator);

  const top = drawRow(headers);
  const divider = widths.map((w) => '-'.repeat(w)).join(separator.replace(/./g, '-'));
  const body = rows.map(drawRow);

  return [top, divider, ...body].join('\n');
}

export function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

export async function mapLimit(items, limit, worker) {
  const actualLimit = Math.max(1, Number(limit || 1));
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      if (current >= items.length) {
        return;
      }
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(actualLimit, items.length); i += 1) {
    runners.push(runWorker());
  }
  await Promise.all(runners);
  return results;
}

export async function calculateDirectorySize(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      return stat.size;
    }
    if (!stat.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let total = 0;
  async function walk(dirPath) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        }
      } catch {
        // ignore single file errors
      }
    }
  }
  await walk(targetPath);
  return total;
}

export function formatUtcDate(tsMillis) {
  const d = new Date(tsMillis);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

export function formatLocalDate(tsMillis) {
  const d = new Date(tsMillis);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export async function appendJsonLine(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

export async function readJsonLines(filePath) {
  const rows = [];
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      try {
        rows.push(JSON.parse(text));
      } catch {
        // ignore invalid line
      }
    }
  } catch {
    return rows;
  }
  return rows;
}

export function printProgress(prefix, current, total) {
  const safeTotal = Math.max(1, total);
  const percent = Math.min(100, Math.floor((current / safeTotal) * 100));
  const line = `${prefix} ${current}/${total} (${percent}%)`;
  process.stdout.write(`\r${line.padEnd(70, ' ')}`);
  if (current >= total) {
    process.stdout.write('\n');
  }
}

export function uniqueBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
