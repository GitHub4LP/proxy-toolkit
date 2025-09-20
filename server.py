#!/usr/bin/env python3
"""
端口管理服务 - 智能端口管理和代理链接生成
"""

import asyncio
import os
import socket
import time
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
        self.app.router.add_get("/api/nginx-encoding-test", self.nginx_encoding_test_handler)
        self.app.router.add_get("/api/test-encoding/{path:.*}", self.test_encoding_handler)
        self.app.router.add_get("/api/test-slash-encoding/{path:.*}", self.test_slash_encoding_handler)
        self.app.router.add_get("/api/test-percent-encoding/{path:.*}", self.test_percent_encoding_handler)
        self.app.router.add_get("/api/test-general-encoding/{path:.*}", self.test_general_encoding_handler)
        self.app.router.add_get("/api/test-double-encoding/{path:.*}", self.test_double_encoding_handler)
        self.app.router.add_get("/api/test-multi-encoding/{path:.*}", self.test_multi_encoding_handler)
        self.app.router.add_get("/api/test-progressive-encoding/{path:.*}", self.test_progressive_encoding_handler)
        # Service Worker 脚本 - 放在根路径以获得最大作用域
        self.app.router.add_get("/subpath_service_worker.js", self.service_worker_handler)

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

    async def nginx_encoding_test_handler(self, request):
        """检测 nginx 是否会自动解码 URL"""
        return web.json_response({
            "chinese_test_path": "/api/test-encoding/中文测试",
            "slash_test_path": "/api/test-slash-encoding/test%2Fpath",
            "percent_test_path": "/api/test-percent-encoding/test%25percent",
            "general_test_path": "/api/test-general-encoding/test%2Fslash%25percent%20space",
            "double_encoding_test_path": "/api/test-double-encoding/file%2520name%252Fpath%2525test",
            "multi_encoding_test_path": "/api/test-multi-encoding/test%252525252520space%2525252525252Fslash%252525252525252525end",
            "progressive_encoding_tests": {
                "layer_1": "/api/test-progressive-encoding/1layer%2Fslash",
                "layer_2": "/api/test-progressive-encoding/2layer%252Fslash", 
                "layer_3": "/api/test-progressive-encoding/3layer%25252Fslash"
            },
            "description": "测试 nginx 解码行为 - 包括渐进式(1-3层)和多层编码(3-5层)测试"
        })

    async def test_encoding_handler(self, request):
        """测试编码处理的端点 - 接收中文路径"""
        path = request.match_info.get("path", "")
        return web.json_response({
            "received_path": path,
            "message": "成功接收到中文测试请求",
            "original_url": str(request.url),
            "timestamp": time.time()
        })

    async def test_slash_encoding_handler(self, request):
        """测试 %2F 编码处理的端点"""
        path = request.match_info.get("path", "")
        return web.json_response({
            "received_path": path,
            "message": "成功接收到%2F测试请求",
            "original_url": str(request.url),
            "timestamp": time.time(),
            "contains_slash": "/" in path,
            "expected_encoded": "test%2Fpath"
        })

    async def test_percent_encoding_handler(self, request):
        """测试 %25 编码检测端点"""
        path = request.match_info.get("path", "")
        # 检查路径中是否包含百分号（说明 %25 被自动解码了）
        has_percent = '%' in path
        return web.json_response({
            "received_path": path,
            "has_percent": has_percent,
            "message": f'%25 {"被自动解码为 %" if has_percent else "未被自动解码"}',
            "original_url": str(request.url),
            "timestamp": time.time()
        })

    async def test_general_encoding_handler(self, request):
        """测试通用编码字符检测端点"""
        path = request.match_info.get("path", "")
        # 检查各种编码字符是否被解码
        results = {
            "received_path": path,
            "slash_decoded": "/" in path,  # %2F -> /
            "percent_decoded": "%" in path,  # %25 -> %
            "space_decoded": " " in path,  # %20 -> space
            "original_url": str(request.url),
            "timestamp": time.time()
        }
        return web.json_response(results)

    async def test_multi_encoding_handler(self, request):
        """测试多层编码检测端点 - 测试3层、4层、5层编码"""
        path = request.match_info.get("path", "")
        
        # 分析接收到的路径
        results = {
            "received_path": path,
            "original_url": str(request.url),
            "timestamp": time.time(),
            "multi_layer_analysis": {
                # 检测不同层次的编码残留
                "has_slash": "/" in path,
                "has_percent_2F": "%2F" in path.upper(),
                "has_percent_252F": "%252F" in path.upper(),
                "has_percent_25252F": "%25252F" in path.upper(),
                "has_percent_2525252F": "%2525252F" in path.upper(),
                
                # 检测空格的多层编码
                "has_space": " " in path,
                "has_percent_20": "%20" in path,
                "has_percent_2520": "%2520" in path,
                "has_percent_252520": "%252520" in path,
                "has_percent_25252520": "%25252520" in path,
                
                # 检测百分号的多层编码
                "has_percent": "%" in path,
                "has_percent_25": "%25" in path,
                "has_percent_2525": "%2525" in path,
                "has_percent_252525": "%252525" in path,
                "has_percent_25252525": "%25252525" in path,
            },
            "encoding_layers_detected": []
        }
        
        # 分析编码层次
        analysis = results["multi_layer_analysis"]
        
        # 分析斜杠编码层次
        if analysis["has_slash"] and not analysis["has_percent_2F"]:
            results["encoding_layers_detected"].append("slash_fully_decoded")
        elif analysis["has_percent_2F"] and not analysis["has_percent_252F"]:
            results["encoding_layers_detected"].append("slash_1_layer_remaining")
        elif analysis["has_percent_252F"] and not analysis["has_percent_25252F"]:
            results["encoding_layers_detected"].append("slash_2_layers_remaining")
        elif analysis["has_percent_25252F"] and not analysis["has_percent_2525252F"]:
            results["encoding_layers_detected"].append("slash_3_layers_remaining")
        elif analysis["has_percent_2525252F"]:
            results["encoding_layers_detected"].append("slash_4_or_more_layers_remaining")
            
        # 分析空格编码层次
        if analysis["has_space"] and not analysis["has_percent_20"]:
            results["encoding_layers_detected"].append("space_fully_decoded")
        elif analysis["has_percent_20"] and not analysis["has_percent_2520"]:
            results["encoding_layers_detected"].append("space_1_layer_remaining")
        elif analysis["has_percent_2520"] and not analysis["has_percent_252520"]:
            results["encoding_layers_detected"].append("space_2_layers_remaining")
        elif analysis["has_percent_252520"] and not analysis["has_percent_25252520"]:
            results["encoding_layers_detected"].append("space_3_layers_remaining")
        elif analysis["has_percent_25252520"]:
            results["encoding_layers_detected"].append("space_4_or_more_layers_remaining")
            
        # 计算解码深度
        max_layers_tested = 5
        layers_decoded = 0
        
        # 基于斜杠编码计算解码层数
        if "slash_fully_decoded" in results["encoding_layers_detected"]:
            layers_decoded = max_layers_tested
        elif "slash_1_layer_remaining" in results["encoding_layers_detected"]:
            layers_decoded = max_layers_tested - 1
        elif "slash_2_layers_remaining" in results["encoding_layers_detected"]:
            layers_decoded = max_layers_tested - 2
        elif "slash_3_layers_remaining" in results["encoding_layers_detected"]:
            layers_decoded = max_layers_tested - 3
        elif "slash_4_or_more_layers_remaining" in results["encoding_layers_detected"]:
            layers_decoded = 1
            
        results["nginx_decode_depth"] = layers_decoded
        results["recommended_encoding_layers"] = layers_decoded + 2  # 建议比检测到的解码深度多2层
        
        return web.json_response(results)

    async def test_double_encoding_handler(self, request):
        """测试双重编码检测端点 - 检测 %25XX 形式的编码"""
        path = request.match_info.get("path", "")
        
        # 分析接收到的路径
        results = {
            "received_path": path,
            "original_url": str(request.url),
            "timestamp": time.time(),
            "analysis": {
                # 检测 %2520 -> %20 -> space 的双重解码
                "has_space": " " in path,
                "has_percent_20": "%20" in path,
                
                # 检测 %252F -> %2F -> / 的双重解码  
                "has_slash": "/" in path,
                "has_percent_2F": "%2F" in path.upper(),
                
                # 检测 %2525 -> %25 -> % 的双重解码
                "has_percent": "%" in path,
                "has_percent_25": "%25" in path,
                
                # 原始路径分析
                "path_segments": path.split("/") if path else [],
                "contains_encoded_chars": "%" in path
            }
        }
        
        # 判断双重解码情况
        if results["analysis"]["has_space"] and not results["analysis"]["has_percent_20"]:
            results["double_decode_detected"] = "space_from_2520"
        elif results["analysis"]["has_slash"] and not results["analysis"]["has_percent_2F"]:
            results["double_decode_detected"] = "slash_from_252F"
        elif results["analysis"]["has_percent"] and not results["analysis"]["has_percent_25"]:
            results["double_decode_detected"] = "percent_from_2525"
        else:
            results["double_decode_detected"] = "none"
            
        return web.json_response(results)

    async def test_multi_encoding_handler(self, request):
        """测试多层编码检测端点 - 检测 nginx 递归解码深度"""
        path = request.match_info.get("path", "")
        
        # 分析接收到的路径
        results = {
            "received_path": path,
            "original_url": str(request.url),
            "timestamp": time.time(),
            "multi_layer_analysis": {
                # 斜杠多层编码检测 (/ -> %2F -> %252F -> %25252F -> %2525252F -> %252525252F)
                "has_slash": "/" in path,
                "has_percent_2F": "%2F" in path.upper(),
                "has_percent_252F": "%252F" in path.upper(),
                "has_percent_25252F": "%25252F" in path.upper(),
                "has_percent_2525252F": "%2525252F" in path.upper(),
                "has_percent_252525252F": "%252525252F" in path.upper(),
                
                # 空格多层编码检测 (space -> %20 -> %2520 -> %252520 -> %25252520 -> %2525252520)
                "has_space": " " in path,
                "has_percent_20": "%20" in path,
                "has_percent_2520": "%2520" in path,
                "has_percent_252520": "%252520" in path,
                "has_percent_25252520": "%25252520" in path,
                "has_percent_2525252520": "%2525252520" in path,
                
                # 百分号多层编码检测 (% -> %25 -> %2525 -> %252525 -> %25252525 -> %2525252525)
                "has_percent": "%" in path,
                "has_percent_25": "%25" in path,
                "has_percent_2525": "%2525" in path,
                "has_percent_252525": "%252525" in path,
                "has_percent_25252525": "%25252525" in path,
                "has_percent_2525252525": "%2525252525" in path,
            },
            "encoding_layers_detected": []
        }
        
        # 分析编码层次
        analysis = results["multi_layer_analysis"]
        
        # 分析斜杠编码层次
        if analysis["has_slash"] and not analysis["has_percent_2F"]:
            results["encoding_layers_detected"].append("slash_fully_decoded")
        elif analysis["has_percent_2F"] and not analysis["has_percent_252F"]:
            results["encoding_layers_detected"].append("slash_1_layer_remaining")
        elif analysis["has_percent_252F"] and not analysis["has_percent_25252F"]:
            results["encoding_layers_detected"].append("slash_2_layers_remaining")
        elif analysis["has_percent_25252F"] and not analysis["has_percent_2525252F"]:
            results["encoding_layers_detected"].append("slash_3_layers_remaining")
        elif analysis["has_percent_2525252F"] and not analysis["has_percent_252525252F"]:
            results["encoding_layers_detected"].append("slash_4_layers_remaining")
        elif analysis["has_percent_252525252F"]:
            results["encoding_layers_detected"].append("slash_5_or_more_layers_remaining")
            
        # 分析空格编码层次
        if analysis["has_space"] and not analysis["has_percent_20"]:
            results["encoding_layers_detected"].append("space_fully_decoded")
        elif analysis["has_percent_20"] and not analysis["has_percent_2520"]:
            results["encoding_layers_detected"].append("space_1_layer_remaining")
        elif analysis["has_percent_2520"] and not analysis["has_percent_252520"]:
            results["encoding_layers_detected"].append("space_2_layers_remaining")
        elif analysis["has_percent_252520"] and not analysis["has_percent_25252520"]:
            results["encoding_layers_detected"].append("space_3_layers_remaining")
        elif analysis["has_percent_25252520"] and not analysis["has_percent_2525252520"]:
            results["encoding_layers_detected"].append("space_4_layers_remaining")
        elif analysis["has_percent_2525252520"]:
            results["encoding_layers_detected"].append("space_5_or_more_layers_remaining")
            
        # 计算解码深度 - 基于剩余编码层数推算已解码层数
        max_layers_tested = 5
        layers_decoded = 1  # 默认至少解码了1层（从测试结果可以看出）
        
        # 分析解码深度
        decode_analysis = []
        
        # 基于斜杠编码分析
        if "slash_fully_decoded" in results["encoding_layers_detected"]:
            slash_decoded = max_layers_tested
            decode_analysis.append(f"斜杠: 解码了{slash_decoded}层")
        elif "slash_1_layer_remaining" in results["encoding_layers_detected"]:
            slash_decoded = max_layers_tested - 1
            decode_analysis.append(f"斜杠: 解码了{slash_decoded}层")
        elif "slash_2_layers_remaining" in results["encoding_layers_detected"]:
            slash_decoded = max_layers_tested - 2
            decode_analysis.append(f"斜杠: 解码了{slash_decoded}层")
        elif "slash_3_layers_remaining" in results["encoding_layers_detected"]:
            slash_decoded = max_layers_tested - 3
            decode_analysis.append(f"斜杠: 解码了{slash_decoded}层")
        elif "slash_4_layers_remaining" in results["encoding_layers_detected"]:
            slash_decoded = max_layers_tested - 4
            decode_analysis.append(f"斜杠: 解码了{slash_decoded}层")
        elif "slash_5_or_more_layers_remaining" in results["encoding_layers_detected"]:
            slash_decoded = 1  # 从5层变成5层或更多，说明至少解码了1层
            decode_analysis.append(f"斜杠: 至少解码了{slash_decoded}层")
        else:
            slash_decoded = 0
            
        # 基于空格编码分析
        if "space_fully_decoded" in results["encoding_layers_detected"]:
            space_decoded = max_layers_tested
            decode_analysis.append(f"空格: 解码了{space_decoded}层")
        elif "space_1_layer_remaining" in results["encoding_layers_detected"]:
            space_decoded = max_layers_tested - 1
            decode_analysis.append(f"空格: 解码了{space_decoded}层")
        elif "space_2_layers_remaining" in results["encoding_layers_detected"]:
            space_decoded = max_layers_tested - 2
            decode_analysis.append(f"空格: 解码了{space_decoded}层")
        elif "space_3_layers_remaining" in results["encoding_layers_detected"]:
            space_decoded = max_layers_tested - 3
            decode_analysis.append(f"空格: 解码了{space_decoded}层")
        elif "space_4_layers_remaining" in results["encoding_layers_detected"]:
            space_decoded = max_layers_tested - 4
            decode_analysis.append(f"空格: 解码了{space_decoded}层")
        elif "space_5_or_more_layers_remaining" in results["encoding_layers_detected"]:
            space_decoded = 1  # 从5层变成5层或更多，说明至少解码了1层
            decode_analysis.append(f"空格: 至少解码了{space_decoded}层")
        else:
            space_decoded = 0
            
        # 取最大解码深度作为nginx的解码能力
        layers_decoded = max(slash_decoded, space_decoded, 1)
        
        results["decode_depth"] = layers_decoded
        results["decode_analysis"] = decode_analysis
        results["recommended_encoding_layers"] = layers_decoded + 2  # 建议比检测到的解码深度多2层
        
        return web.json_response(results)

    async def test_progressive_encoding_handler(self, request):
        """渐进式编码测试端点 - 测试1层、2层、3层编码的解码行为"""
        path = request.match_info.get("path", "")
        
        # 分析接收到的路径
        results = {
            "received_path": path,
            "original_url": str(request.url),
            "timestamp": time.time(),
            "progressive_analysis": {
                # 检测原始字符
                "has_slash": "/" in path,
                "has_space": " " in path,
                "has_percent": "%" in path,
                
                # 检测1层编码残留
                "has_percent_2F": "%2F" in path.upper(),
                "has_percent_20": "%20" in path,
                "has_percent_25": "%25" in path,
                
                # 检测2层编码残留
                "has_percent_252F": "%252F" in path.upper(),
                "has_percent_2520": "%2520" in path,
                "has_percent_2525": "%2525" in path,
                
                # 检测3层编码残留
                "has_percent_25252F": "%25252F" in path.upper(),
                "has_percent_252520": "%252520" in path,
                "has_percent_252525": "%252525" in path,
            }
        }
        
        # 分析解码行为
        analysis = results["progressive_analysis"]
        decode_behavior = []
        
        # 分析斜杠解码
        if analysis["has_slash"]:
            if "1layer" in path:
                decode_behavior.append("1层编码的%2F被完全解码为/")
            elif "2layer" in path:
                decode_behavior.append("2层编码被解码到原始字符/")
            elif "3layer" in path:
                decode_behavior.append("3层编码被解码到原始字符/")
        elif analysis["has_percent_2F"]:
            if "2layer" in path:
                decode_behavior.append("2层编码的%252F被解码1层为%2F")
            elif "3layer" in path:
                decode_behavior.append("3层编码被解码到1层编码%2F")
        elif analysis["has_percent_252F"]:
            if "3layer" in path:
                decode_behavior.append("3层编码的%25252F被解码1层为%252F")
        elif analysis["has_percent_25252F"]:
            decode_behavior.append("3层编码保持不变")
            
        # 推断nginx解码策略
        if analysis["has_slash"] and ("1layer" in path):
            nginx_strategy = "单次完全解码"
        elif analysis["has_percent_2F"] and ("2layer" in path):
            nginx_strategy = "单次解码一层"
        elif analysis["has_percent_252F"] and ("3layer" in path):
            nginx_strategy = "单次解码一层"
        else:
            nginx_strategy = "未知或无解码"
            
        results["decode_behavior"] = decode_behavior
        results["nginx_strategy"] = nginx_strategy
        
        return web.json_response(results)

    async def service_worker_handler(self, request):
        """提供 Service Worker 脚本 - 支持模板替换"""
        try:
            sw_file = os.path.join(os.path.dirname(__file__), "subpath_service_worker.js")
            with open(sw_file, "r", encoding="utf-8") as f:
                content = f.read()
            
            # 获取编码配置参数
            chinese_encoding = request.query.get('chinese', 'false').lower() == 'true'
            slash_encoding = request.query.get('slash', 'false').lower() == 'true'
            percent_encoding = request.query.get('percent', 'false').lower() == 'true'
            
            # 替换模板标记
            content = content.replace('{{NEEDS_CHINESE_ENCODING}}', str(chinese_encoding).lower())
            content = content.replace('{{NEEDS_SLASH_ENCODING}}', str(slash_encoding).lower())
            content = content.replace('{{NEEDS_PERCENT_ENCODING}}', str(percent_encoding).lower())
            
            return web.Response(
                text=content,
                content_type="application/javascript",
                headers={
                    "Service-Worker-Allowed": "/",  # 允许控制根路径下的所有作用域
                    "Cache-Control": "no-cache"
                }
            )
        except FileNotFoundError:
            return web.Response(text="Service Worker 脚本未找到", status=404)



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

        print(f"[启动] 服务已启动: http://{self.host}:{self.port}")
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
