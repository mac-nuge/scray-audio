'use strict';
const path = require('node:path');
const fs = require('node:fs');
async function build() {
  const { packager } = await import('@electron/packager');
  const root = path.join(__dirname, '..');
  const previous = path.join(root, 'dist', 'Scray-Audio-win32-x64');
  if (['data', 'Offline'].some(name => fs.existsSync(path.join(previous, name)))) {
    throw new Error('The previous build contains user data. Move that app folder to a safe location before rebuilding.');
  }
  const result = await packager({
    dir: root, name: 'Scray-Audio', platform: 'win32', arch: 'x64',
    out: path.join(root, 'dist'), overwrite: true,
    icon: path.join(root, 'assets', 'app.ico'),
    ignore: [/^\/(dist|data|Offline|test|scripts)(\/|$)/],
    executableName: 'Scray-Audio',
    win32metadata: { CompanyName: 'Scray', FileDescription: 'Scray Audio', ProductName: 'Scray Audio' },
  });
  console.log(result.join('\n'));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
