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
    # 获取脚本所在目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    requirements_file = os.path.join(script_dir, "requirements.txt")
    
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
    
    # 如果依赖文件存在，使用文件安装
    if os.path.exists(requirements_file):
        print(f"[安装] 正在安装依赖文件: {requirements_file}")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", requirements_file])
            print("[完成] 依赖安装成功")
            return
        except subprocess.CalledProcessError as e:
            print(f"[警告] 依赖文件安装失败: {e}")
    
    # 回退到直接安装依赖包
    dependencies = ["aiohttp", "jupyter-server", "psutil", "requests"]
    print("[安装] 正在安装核心依赖包")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install"] + dependencies)
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