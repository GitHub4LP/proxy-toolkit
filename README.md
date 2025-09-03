# 端口管理服务

一个轻量级的端口监听状态管理工具，支持Service Worker代理和实时状态监控。

## 功能特性

### 后端功能
- **端口监听检测**: 自动检测系统端口监听状态
- **进程信息获取**: 显示端口对应的进程PID和命令行信息
- **RESTful API**: 提供完整的端口管理API接口
- **跨平台支持**: 支持Linux/macOS/Windows系统

### 前端功能
- **表格化展示**: 简洁的表格布局显示端口信息
- **状态图标**: 直观的图标显示监听状态和Service Worker状态
- **Service Worker管理**: 自动检测和管理subpath_service_worker.js
- **实时更新**: 5秒间隔自动刷新端口状态

## 界面说明

### 状态图标
- **监听状态**: 
  - 🟢 绿色圆点 - 端口正在监听
  - 🔴 红色圆点 - 端口未监听
- **Service Worker状态**:
  - 🟡 黄色补丁 - 未注册，点击注册
  - 🟢 绿色补丁 - 已注册，点击注销
  - 🔴 红色补丁 - 注册失败，点击重试
  - 🔄 旋转图标 - 处理中

### 表格列说明
1. **状态**: 端口监听状态图标
2. **端口**: 端口号
3. **URL**: 代理访问链接
4. **进程**: 格式为 `(PID) 命令行`，长命令行会截断并显示tooltip
5. **SW**: Service Worker状态和操作按钮

## 技术实现

### 后端架构
- **FastAPI**: 现代Python Web框架
- **psutil**: 系统进程和网络信息获取
- **静态文件服务**: 集成前端资源服务

### 前端架构
- **原生JavaScript**: 无框架依赖，轻量级实现
- **Service Worker API**: 浏览器原生代理支持
- **实时更新**: 定时刷新机制

### API接口
```
GET  /api/ports        # 获取所有端口信息
GET  /api/port/{port}  # 获取指定端口信息
```

### 数据结构
```python
class PortInfo:
    port: int                    # 端口号
    is_listening: bool          # 是否监听
    process_name: str           # 进程名
    process_pid: int            # 进程PID
    process_cmdline: str        # 命令行
    proxy_url: str              # 代理URL
```

## 使用场景

### 端口状态监控
- 实时查看系统端口监听状态
- 识别端口对应的进程和服务
- 快速定位端口占用情况

### 子路径代理管理
- 在JupyterHub等子路径环境中管理Service Worker
- 解决子路径下的跨域和代理问题
- 一键注册/注销subpath_service_worker.js

### 开发调试辅助
- 查看本地服务的端口占用
- 通过代理URL快速访问本地服务
- 监控多个开发服务的运行状态