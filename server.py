#!/usr/bin/env python3
"""
端口管理服务 - 智能端口管理和代理链接生成
"""

import asyncio
import os
import socket
import time
import urllib
from typing import Dict, Optional

import psutil
from aiohttp import web

from port_proxy import detect_service_config, generate_proxy_url


def get_available_port():
    """获取系统分配的可用端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("", 0))  # 让系统分配端口
        return sock.getsockname()[1]


class PortInfo:
    """端口信息类"""

    def __init__(self, port: int):
        self.port = port
        self.is_listening = False
        self.process_name: Optional[str] = None
        self.process_pid: Optional[int] = None
        self.process_cmdline: Optional[str] = None
        self.last_check = 0
        self.proxy_url: Optional[str] = None

    def to_dict(self) -> Dict:
        return {
            "port": self.port,
            "is_listening": self.is_listening,
            "process_name": self.process_name,
            "process_pid": self.process_pid,
            "process_cmdline": self.process_cmdline,
            "proxy_url": self.proxy_url,
        }


class PortServer:
    """端口管理服务器"""

    def __init__(self, host: str = "0.0.0.0", port: int = None):
        self.host = host
        self.port = port if port is not None else get_available_port()
        self.app = web.Application()
        self.port_cache: Dict[int, PortInfo] = {}
        self.proxy_template = detect_service_config()
        self._setup_routes()

    def _setup_routes(self):
        """设置路由"""
        self.app.router.add_get("/", self.index_handler)
        self.app.router.add_get("/api/ports", self.list_ports_handler)
        self.app.router.add_get("/api/port/{port}", self.port_info_handler)
        self.app.router.add_get("/api/url-template", self.url_template_handler)
        self.app.router.add_get("/api/test-encoding/{path:.*}", self.test_encoding_handler)
        # 路径模式隧道（保持方法与体，端口在路径，余路径在参数 u）
        self.app.router.add_route("*", "/api/http-tunnel/{port:\\d+}", self.http_tunnel_handler)
        # Service Worker 脚本 - 放在根路径以获得最大作用域
        self.app.router.add_get("/unified_service_worker.js", self.unified_service_worker_handler)
        self.app.router.add_get("/navigation_interceptor.js", self.navigation_interceptor_handler)

        # 静态文件
        static_dir = os.path.join(os.path.dirname(__file__), "static")
        if os.path.exists(static_dir):
            self.app.router.add_static("/static/", static_dir)

    async def index_handler(self, request):
        """首页处理器"""
        try:
            with open(
                os.path.join(os.path.dirname(__file__), "static", "index.html"),
                "r",
                encoding="utf-8",
            ) as f:
                return web.Response(text=f.read(), content_type="text/html")
        except FileNotFoundError:
            return web.Response(text="静态文件未找到", status=404)

    async def list_ports_handler(self, request):
        """获取端口列表"""
        for port_info in self.port_cache.values():
            self._update_port_info(port_info)

        ports = [port_info.to_dict() for port_info in self.port_cache.values()]
        ports.sort(key=lambda x: x["port"])
        return web.json_response(ports)

    async def port_info_handler(self, request):
        """获取特定端口信息"""
        try:
            port = int(request.match_info["port"])
        except ValueError:
            return web.json_response({"error": "无效的端口号"}, status=400)

        if port not in self.port_cache:
            self.port_cache[port] = PortInfo(port)

        port_info = self.port_cache[port]
        self._update_port_info(port_info)
        return web.json_response(port_info.to_dict())

    async def url_template_handler(self, request):
        """获取当前环境的URL模板"""
        template = detect_service_config()
        return web.json_response({
            "template": template,
            "has_proxy_support": bool(template)
        })

    async def test_encoding_handler(self, request):
        """nginx解码深度检测端点 - 返回nginx解码后的路径"""
        match_path = request.match_info.get("path", "")
        restored_path = urllib.parse.quote(match_path, safe='')
        return web.json_response({"path": restored_path})

    async def unified_service_worker_handler(self, request):
        """提供统一的Service Worker脚本"""
        try:
            sw_file = os.path.join(os.path.dirname(__file__), "unified_service_worker.js")
            with open(sw_file, "r", encoding="utf-8") as f:
                content = f.read()
            
            return web.Response(
                text=content,
                content_type="application/javascript",
                headers={
                    "Service-Worker-Allowed": "/",
                    "Cache-Control": "no-cache"
                }
            )
        except FileNotFoundError:
            return web.Response(text="统一Service Worker脚本未找到", status=404)

    async def navigation_interceptor_handler(self, request):
        """提供导航拦截器脚本"""
        try:
            script_file = os.path.join(os.path.dirname(__file__), "navigation_interceptor.js")
            with open(script_file, "r", encoding="utf-8") as f:
                content = f.read()
            
            return web.Response(
                text=content,
                content_type="application/javascript",
                headers={
                    "Cache-Control": "no-cache",
                    "Access-Control-Allow-Origin": "*"
                }
            )
        except FileNotFoundError:
            return web.Response(text="导航拦截器脚本未找到", status=404)



    async def http_tunnel_handler(self, request):
        """HTTP隧道处理器（路径模式） - 保持方法与体，端口在路径，目标余路径在参数u"""
        try:
            port_str = request.match_info.get('port', '')
            try:
                port = int(port_str)
                if port <= 0 or port > 65535:
                    return web.Response(text="无效端口", status=400)
            except ValueError:
                return web.Response(text="端口解析失败", status=400)

            u = request.query.get('u', '')
            if not u or not u.startswith('/'):
                return web.Response(text="缺少或非法参数u", status=400)

            target_url = f"http://localhost:{port}{u}"

            import aiohttp
            timeout = aiohttp.ClientTimeout(total=30)

            # 过滤可能导致问题的头
            skip_headers = {
                'host', 'content-length', 'connection', 'upgrade',
                'proxy-connection', 'proxy-authorization', 'transfer-encoding'
            }
            clean_headers = {
                k: v for k, v in request.headers.items()
                if k.lower() not in skip_headers
                and not k.lower().startswith(('x-forwarded-', 'x-proxy'))
            }
            # 重写来源相关头为目标源，满足常见CSRF/同源校验
            target_origin = f"http://localhost:{port}"
            clean_headers['Origin'] = target_origin
            clean_headers['Referer'] = target_origin + '/'

            body = None
            if request.can_read_body:
                try:
                    body = await request.read()
                except Exception:
                    body = None



            async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as session:
                try:
                    async with session.request(
                        method=request.method,
                        url=target_url,
                        headers=clean_headers,
                        data=body,
                        allow_redirects=False
                    ) as upstream:
                        # 过滤响应中的 hop-by-hop 和长度相关头，由服务器按实际写入决定
                        resp_headers = dict(upstream.headers)
                        for hk in ('transfer-encoding', 'connection', 'content-length'):
                            resp_headers.pop(hk, None)



                        # 流式透传上游响应
                        stream_resp = web.StreamResponse(
                            status=upstream.status,
                            reason=upstream.reason or ''
                        )
                        for k, v in resp_headers.items():
                            stream_resp.headers[k] = v
                        await stream_resp.prepare(request)
                        async for chunk in upstream.content.iter_chunked(65536):
                            await stream_resp.write(chunk)
                        await stream_resp.write_eof()
                        return stream_resp
                except aiohttp.ClientError as e:
                    return web.Response(text=f"请求转发失败: {e}", status=502)
                except asyncio.TimeoutError:
                    return web.Response(text="请求超时", status=504)

        except Exception as e:
            print(f"[路径隧道错误] {e}")
            return web.Response(text=f"隧道处理异常: {e}", status=500)

    def _update_port_info(self, port_info: PortInfo):
        """更新端口信息"""
        # 避免频繁检查
        if time.time() - port_info.last_check < 5:
            return

        port_info.last_check = time.time()
        port_info.is_listening = self._is_port_listening(port_info.port)

        if port_info.is_listening:
            process_info = self._get_port_process(port_info.port)
            if process_info:
                port_info.process_pid = process_info.get('pid')
                port_info.process_name = process_info.get('name')
                port_info.process_cmdline = process_info.get('cmdline')
            else:
                port_info.process_pid = None
                port_info.process_name = None
                port_info.process_cmdline = None
        else:
            port_info.process_pid = None
            port_info.process_name = None
            port_info.process_cmdline = None

        port_info.proxy_url = generate_proxy_url(port_info.port)

    def _is_port_listening(self, port: int) -> bool:
        """检查端口是否在监听"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                result = sock.connect_ex(("127.0.0.1", port))
                return result == 0
        except Exception:
            return False

    def _get_port_process(self, port: int) -> Optional[Dict]:
        """获取监听端口的进程信息"""
        try:
            for conn in psutil.net_connections(kind="inet"):
                if (
                    conn.status == psutil.CONN_LISTEN
                    and conn.laddr
                    and conn.laddr.port == port
                    and conn.pid
                ):
                    try:
                        process = psutil.Process(conn.pid)
                        cmdline = process.cmdline()
                        # 将命令行参数列表合并为字符串
                        cmdline_str = ' '.join(cmdline) if cmdline else process.name()
                        
                        return {
                            'pid': conn.pid,
                            'name': process.name(),
                            'cmdline': cmdline_str
                        }
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
        except Exception:
            pass
        return None

    async def start_server(self):
        """启动服务器"""
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()

        # 生成本服务的访问URL
        local_url = f"http://{self.host}:{self.port}"
        proxy_url = generate_proxy_url(self.port)
        
        if proxy_url:
            print(f"[启动] 服务已启动，请访问: {proxy_url}")
            print(f"[本地] 本地地址: {local_url}")
        else:
            print(f"[启动] 服务已启动: {local_url}")
        
        return runner

    async def stop_server(self, runner):
        """停止服务器"""
        await runner.cleanup()



def check_subpath_requirement():
    """检查是否需要启动Service Worker服务"""
    from urllib.parse import urlparse
    
    proxy_template = detect_service_config()
    
    if not proxy_template:
        print("[跳过] 未检测到代理环境")
        return False
    
    # 提取路径部分
    if proxy_template.startswith(("http://", "https://")):
        parsed = urlparse(proxy_template)
        template_path = parsed.path
    else:
        template_path = proxy_template
    
    # 判断是否为根路径
    if template_path in ["/", ""]:
        print("[跳过] 根路径环境")
        return False
    
    print(f"[检测] 子路径环境: {template_path}")
    return True


async def main():
    """主函数"""
    import argparse
    import signal

    parser = argparse.ArgumentParser(description="端口管理服务器")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", type=int, help="监听端口 (默认系统分配)")
    args = parser.parse_args()

    # 检查是否需要启动服务
    needs_service = check_subpath_requirement()
    
    if not needs_service:
        print("[跳过] 无需启动服务")
        return

    server = PortServer(args.host, args.port)
    runner = None

    # 优雅退出处理
    shutdown_event = asyncio.Event()

    def signal_handler():
        print("\n[退出] 正在关闭...")
        shutdown_event.set()

    # 注册信号处理器 (仅在 Unix 系统上)
    try:
        if hasattr(signal, "SIGINT") and os.name != "nt":
            loop = asyncio.get_event_loop()
            loop.add_signal_handler(signal.SIGINT, signal_handler)
    except NotImplementedError:
        # Windows 系统不支持 add_signal_handler
        pass

    try:
        runner = await server.start_server()
        print("[提示] 按 Ctrl+C 退出服务器")

        # 等待退出信号
        await shutdown_event.wait()

    except KeyboardInterrupt:
        print("\n[退出] 正在关闭...")
    except Exception as e:
        print(f"\n[错误] {e}")
    finally:
        if runner:
            try:
                await server.stop_server(runner)
                print("[完成] 已关闭")
            except Exception as e:
                print(f"[警告] {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # 静默处理 KeyboardInterrupt，避免显示堆栈跟踪
        pass
