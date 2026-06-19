import * as path from 'path';
import { glob } from 'glob';

export function run(): Promise<void> {
  const testsRoot = path.resolve(__dirname, '..');
  return new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }).then((files) => {
      // basic Mocha-compatible runner — expand in later tasks
      if (files.length === 0) resolve();
      else reject(new Error('Test runner not yet wired'));
    }).catch(reject);
  });
}
