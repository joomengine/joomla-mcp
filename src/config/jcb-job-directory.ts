import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}

export async function validateJcbJobDirectory(path: string, joomlaRoot: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('JCB job directory must be an absolute path.');
  const [directory, root] = await Promise.all([realpath(path), realpath(joomlaRoot)]);
  if (directory !== resolve(path) || contains(directory, root) || contains(root, directory)) {
    throw new Error('JCB job storage must be a separate directory outside Joomla, without symlinks.');
  }
  const metadata = await stat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())) {
    throw new Error('JCB job directory must be owned by the service account with mode 0700.');
  }
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  return directory;
}
