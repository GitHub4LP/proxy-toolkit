# JupyterLab Proxy Toolkit

JupyterLab 扩展，通过 Service Worker 解决子路径代理环境下的 URL 重写问题。

## 功能

- Service Worker 自动修正子路径 URL
- 支持四种代理策略：None / Subpath / Tunnel / Hybrid
- 自动检测反向代理编码行为
- 在 JupyterLab 内嵌显示端口管理界面

## 依赖

- JupyterLab >= 4.0.0
- jupyter-server-proxy

## 安装

```bash
pip install jupyter-server-proxy
pip install dist/*.whl
```

## 使用

1. 在 JupyterLab Launcher 的 "Other" 分类中点击 "Proxy Toolkit"
2. 扩展会自动启动后端服务
3. 通过界面管理端口和 SW 策略

## 代理策略

| 策略 | 适用场景 |
|-----|---------|
| None | 禁用 SW |
| Subpath | 标准反向代理，路径前缀修正 |
| Tunnel | 复杂代理环境，完整请求透传 |
| Hybrid | `%2F` 被额外解码的环境 |

## License

MIT
