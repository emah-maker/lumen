// electron-builder afterPack hook: remove Electron's placeholder app from the build.
const fs = require('fs');
const path = require('path');

exports.default = async ({ appOutDir }) => {
  fs.rmSync(path.join(appOutDir, 'resources', 'default_app.asar'), { force: true });
};
