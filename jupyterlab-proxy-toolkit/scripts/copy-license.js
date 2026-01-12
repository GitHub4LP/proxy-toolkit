/**
 * 构建前复制 LICENSE 文件
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const extDir = path.join(__dirname, '..');

const srcPath = path.join(rootDir, 'LICENSE');
const destPath = path.join(extDir, 'LICENSE');

if (fs.existsSync(srcPath)) {
  fs.copyFileSync(srcPath, destPath);
  console.log('Copied: LICENSE');
} else {
  console.error('Source file not found: LICENSE');
  process.exit(1);
}
