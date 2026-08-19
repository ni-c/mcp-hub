import fs from 'node:fs';
import path from 'node:path';

/**
 * Mountinfo escapes space, tab, newline and backslash as octal (\040 etc.);
 * everything else is verbatim.
 */
function unescapeMountPath(value: string): string {
  return value.replace(/\\(\d{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Warns when the config file is itself a mount point — i.e. a single-file
 * bind mount. Those look fine until the first host-side edit: editors save
 * via rename, which creates a new inode the mount cannot follow, so the
 * container keeps reading the old file forever and hot reload silently dies.
 * The polling watcher cannot catch that either; only mounting the directory
 * does. Saying so at startup beats debugging it at edit time.
 *
 * Best-effort by design: no /proc (non-Linux, restricted container) means no
 * check, never an error.
 */
export function warnSingleFileMount(filePath: string, component: string, mountinfoPath = '/proc/self/mountinfo'): void {
  let mountinfo: string;
  try {
    mountinfo = fs.readFileSync(mountinfoPath, 'utf8');
  } catch {
    return;
  }
  const target = path.resolve(filePath);
  for (const line of mountinfo.split('\n')) {
    // 36 35 98:0 /root /mount-point rw,noatime shared:1 - ext4 /dev/sda rw
    const mountPoint = line.split(' ')[4];
    if (mountPoint === undefined) continue;
    if (unescapeMountPath(mountPoint) !== target) continue;
    console.warn(
      `${component}: ${target} is a single-file bind mount — host edits that replace the file (most editors do) ` +
        'are never seen inside the container, so hot reload will miss them. Mount the directory instead (e.g. ./config:/config:ro).'
    );
    return;
  }
}
