# JupyterLab Proxy Toolkit

JupyterLab 扩展，通过 Service Worker 解决子路径代理环境下的 URL 重写问题。

## 功能

- Service Worker 自动修正子路径 URL
- 支持四种代理策略：None / Subpath / Tunnel / Hybrid
- 自动检测反向代理编码行为
- 在 JupyterLab 内嵌显示端口管理界面

## 前置条件

```bash
pip install jupyter-server-proxy
```

## 安装

```bash
pip install jupyterlab-proxy-toolkit
```

## 使用

1. 在 JupyterLab Launcher 的 "Other" 分类中点击 "Proxy Toolkit"
2. 扩展会自动启动后端服务
3. 通过界面管理端口和 SW 策略

## 开发

```bash
cd jupyterlab-proxy-toolkit

# 安装依赖
npm install
pip install -e ".[dev]"

# 构建（会先从根目录复制共用文件）
npm run build:prod

# 开发模式
npm run build
jupyter labextension develop . --overwrite
jupyter lab
```

## 共用文件

本扩展的核心文件从项目根目录复制：
- `unified_service_worker.js`
- `navigation_interceptor.js`
- `sw_client.js`
- `port_proxy.py`
- `server.py`
- `static/` 目录

构建时通过 `npm run prebuild` 自动复制。

## License

MIT - 详见项目根目录 [LICENSE](../LICENSE)
