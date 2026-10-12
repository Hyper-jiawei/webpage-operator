#!/usr/bin/env node
// 把仓库内的技能安装到 Qoder 用户技能目录（符号链接方式，仓库更新即时生效）。
// 若目标已是 Qoder 管理的实体目录，请改用 skill_manage 更新内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', 'skills', 'webpage-operator');
const dest = path.join(os.homedir(), '.qoder', 'skills', 'webpage-operator');

if (!fs.existsSync(src)) {
  console.error(`缺少技能源目录：${src}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
const existing = fs.existsSync(dest) ? fs.lstatSync(dest) : null;
if (existing && !existing.isSymbolicLink()) {
  console.error(`目标已存在实体目录：${dest}\n如需更新请先备份并删除，或使用 Qoder 的 skill_manage 更新技能内容。`);
  process.exit(1);
}
if (existing) fs.unlinkSync(dest);
fs.symlinkSync(src, dest, 'dir');
console.log(`已安装技能：${dest} -> ${src}`);
