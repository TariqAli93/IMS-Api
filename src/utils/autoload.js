import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

export async function autoloadRoutes(app, dir) {
  if (!existsSync(dir)) {
    app.log.error({ dir }, 'Modules directory not found');
    return;
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const isDir = statSync(full).isDirectory();
    if (isDir) {
      await autoloadRoutes(app, full);
    } else if (name.endsWith('routes.js') && !name.startsWith('index')) {
      const fileUrl = pathToFileURL(full).href;
      const mod = await import(fileUrl);
      if (typeof mod.default === 'function') {
        await app.register(mod.default, { prefix: '/' + pathToPrefix(full) });
      }
    }
  }
}
function pathToPrefix(p) {
  const parts = p.split(/[/\\]/);
  const i = parts.lastIndexOf('modules');
  return parts[i + 1] || '';
}
