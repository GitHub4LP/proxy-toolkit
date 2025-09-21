#!/usr/bin/env python3
"""
Gradio环境端口管理服务启动器
"""

import asyncio
import os
import subprocess
import sys


def install_dependencies():
    """自动安装依赖包"""
    requirements_file = "requirements.txt"
    
    # 检查依赖文件是否存在
    if not os.path.exists(requirements_file):
        print(f"[错误] 依赖文件 {requirements_file} 不存在")
        sys.exit(1)
    
    # 检查关键依赖是否已安装
    try:
        import aiohttp
        import psutil
        import requests
        import jupyter_server
        print("[检查] 依赖已安装")
        return
    except ImportError:
        pass
    
    # 安装依赖
    print(f"[安装] 正在安装依赖文件: {requirements_file}")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", requirements_file])
        print("[完成] 依赖安装成功")
    except subprocess.CalledProcessError as e:
        print(f"[错误] 依赖安装失败: {e}")
        sys.exit(1)


# 自动安装依赖
install_dependencies()

from server import PortServer


async def main():
    """Gradio环境主函数"""
    # 从环境变量获取端口，默认7860
    port = int(os.environ.get("GRADIO_SERVER_PORT", 7860))
    
    # 启动端口管理服务
    server = PortServer("0.0.0.0", port)
    runner = await server.start_server()
    
    try:
        # 保持服务运行
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await server.stop_server(runner)


if __name__ == "__main__":
    asyncio.run(main())