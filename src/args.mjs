// 极简参数解析：支持 `--flag value`、`--flag=value`、布尔 `--flag`，其余为位置参数。
// 值以 `--` 开头时请使用 `--flag=--value` 形式。
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      if (eq > 2) {
        flags[item.slice(2, eq)] = item.slice(eq + 1);
      } else {
        const key = item.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(item);
    }
  }
  return { positionals, flags };
}

export const toNumber = value => (value === undefined || value === true || value === '' ? undefined : Number(value));
