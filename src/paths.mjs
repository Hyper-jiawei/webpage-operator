import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// 运行数据一律放在仓库之外的 ~/.webop（可用 WEBOP_HOME 覆盖）：
// profile/ 保存浏览器登录状态（绝不进入仓库），screenshots/ 保存截图，run/ 保存进程状态。
export const HOME_DIR = process.env.WEBOP_HOME || path.join(os.homedir(), '.webop');
export const PROFILE_DIR = path.join(HOME_DIR, 'profile');
export const RUN_DIR = path.join(HOME_DIR, 'run');
export const SHOT_DIR = path.join(HOME_DIR, 'screenshots');
export const LOG_PATH = path.join(HOME_DIR, 'daemon.log');
export const STATE_PATH = path.join(RUN_DIR, 'state.json');
export const DEFAULT_PORT = Number(process.env.WEBOP_PORT || 17321);

export async function ensureDirs() {
  for (const dir of [HOME_DIR, PROFILE_DIR, RUN_DIR, SHOT_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
}
