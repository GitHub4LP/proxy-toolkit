/**
 * 构建前复制共用文件到扩展目录
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const extDir = path.join(__dirname, '..');
const serverDir = path.join(extDir, 'jupyterlab_proxy_toolkit', 'server');
const staticDir = path.join(serverDir, 'static');

// JS 文件 → server/
const jsFiles = [
  'unified_service_worker.js',
  'navigation_interceptor.js',
  'sw_client.js'
];

// Python 文件 → server/
const pyFiles = [
  { src: 'port_proxy.py', dest: 'port_proxy.py' },
  { src: 'server.py', dest: 'server.py' }
];

// 静态文件 → server/static/
const staticFiles = [
  { src: 'static/index.html', dest: 'index.html' },
  { src: 'static/app.js', dest: 'app.js' },
  { src: 'static/style.css', dest: 'style.css' }
];

// 根目录文件 → 扩展根目录
const rootFiles = [
  'LICENSE'
];

// 确保目录存在
fs.mkdirSync(serverDir, { recursive: true });
fs.mkdirSync(staticDir, { recursive: true });

// 复制 JS 文件
jsFiles.forEach(file => {
  const srcPath = path.join(rootDir, file);
  const destPath = path.join(serverDir, file);
  
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied: ${file} -> server/`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

// 复制 Python 文件（需要修改 import）
pyFiles.forEach(({ src, dest }) => {
  const srcPath = path.join(rootDir, src);
  const destPath = path.join(serverDir, dest);
  
  if (fs.existsSync(srcPath)) {
    let content = fs.readFileSync(srcPath, 'utf-8');
    
    // 修改 server.py 的 import 语句
    if (src === 'server.py') {
      content = content.replace(
        'from port_proxy import',
        'from .port_proxy import'
      );
    }
    
    fs.writeFileSync(destPath, content);
    console.log(`Copied: ${src} -> server/${dest}`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

// 复制静态文件（需要修改 index.html 的 sw_client.js 路径）
staticFiles.forEach(({ src, dest }) => {
  const srcPath = path.join(rootDir, src);
  const destPath = path.join(staticDir, dest);
  
  if (fs.existsSync(srcPath)) {
    let content = fs.readFileSync(srcPath, 'utf-8');
    
    // 修改 index.html 的 sw_client.js 路径（从根路径改为相对路径）
    if (src === 'static/index.html') {
      // 原: <script src="sw_client.js"></script>
      // 改: <script src="../sw_client.js"></script>
      // 因为 static/index.html 访问的 sw_client.js 在 server/ 目录
      content = content.replace(
        '<script src="sw_client.js"></script>',
        '<script src="../sw_client.js"></script>'
      );
    }
    
    fs.writeFileSync(destPath, content);
    console.log(`Copied: ${src} -> server/static/${dest}`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

// 复制根目录文件
rootFiles.forEach(file => {
  const srcPath = path.join(rootDir, file);
  const destPath = path.join(extDir, file);
  
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied: ${file} -> ./`);
  } else {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
});

console.log('Shared files copied successfully.');
