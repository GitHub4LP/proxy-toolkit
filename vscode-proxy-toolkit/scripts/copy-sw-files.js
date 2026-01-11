/**
 * 构建前复制核心文件到扩展目录
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', '..');
const extDir = path.join(__dirname, '..');
const resourcesDir = path.join(extDir, 'resources');

// SW 相关文件 → resources/
const swFiles = [
  'unified_service_worker.js',
  'navigation_interceptor.js',
  'sw_client.js'
];

// 根目录文件 → 扩展根目录
const rootFiles = [
  'LICENSE'
];

fs.mkdirSync(resourcesDir, { recursive: true });

// 复制 SW 文件
swFiles.forEach(file => {
  const srcPath = path.join(srcDir, file);
  const destPath = path.join(resourcesDir, file);
  
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied: ${file} -> resources/`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

// 复制根目录文件
rootFiles.forEach(file => {
  const srcPath = path.join(srcDir, file);
  const destPath = path.join(extDir, file);
  
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied: ${file} -> ./`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

console.log('Files copied successfully.');
