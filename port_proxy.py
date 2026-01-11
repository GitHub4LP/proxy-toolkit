import os
from typing import cast
import json
from urllib.parse import urlparse
from pathlib import Path


# 缓存 runtime 目录
_cached_runtime_dir: Path | None | bool = False  # False 表示未初始化


def _get_jupyter_runtime_dir() -> Path | None:
    """获取 Jupyter runtime 目录（带缓存）"""
    global _cached_runtime_dir
    
    if _cached_runtime_dir is not False:
        return _cached_runtime_dir  # type: ignore[return-value]
    
    # 优先使用 jupyter_core（准确、跨平台）
    try:
        from jupyter_core.paths import jupyter_runtime_dir
        _cached_runtime_dir = Path(jupyter_runtime_dir())
        return _cached_runtime_dir
    except ImportError:
        pass
    
    # 回退到各平台默认路径
    import platform
    system = platform.system()
    if system == "Darwin":
        runtime_dir = Path.home() / "Library/Jupyter/runtime"
    elif system == "Windows":
        runtime_dir = Path.home() / "AppData/Roaming/jupyter/runtime"
    else:  # Linux
        runtime_dir = Path.home() / ".local/share/jupyter/runtime"
    
    _cached_runtime_dir = runtime_dir if runtime_dir.exists() else None
    return _cached_runtime_dir


def _list_jupyter_servers() -> list[dict[str, str | int]]:
    """从 runtime 目录读取运行中的 Jupyter server 信息"""
    runtime_dir = _get_jupyter_runtime_dir()
    if not runtime_dir:
        return []
    
    servers: list[dict[str, str | int]] = []
    for json_file in runtime_dir.glob("jpserver-*.json"):
        try:
            with open(json_file, "r") as f:
                server_info = json.load(f)
                servers.append(server_info)
        except (json.JSONDecodeError, IOError):
            continue
    
    return servers


def check_jupyter_proxy() -> str:
    """检查JupyterLab代理配置"""

    if "STUDIO_MODEL_API_URL_PREFIX" in os.environ:  # AI Studio
        protocol_host = os.environ["STUDIO_MODEL_API_URL_PREFIX"]
        path_template = os.environ["JUPYTERHUB_SERVICE_PREFIX"] + r"gradio/{{port}}/"
        if protocol_host:
            return protocol_host + path_template
        else:
            return ""

    servers = _list_jupyter_servers()
    if not servers:
        return ""

    import socket
    import threading
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from urllib.request import urlopen
    from urllib.error import URLError

    proxy_template = r"proxy/{{port}}/"
    
    # 找个可用端口
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        test_port = s.getsockname()[1]
    
    # 最简单的测试服务
    class TestHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
        def log_message(self, format, *args): pass
    
    test_server = HTTPServer(('127.0.0.1', test_port), TestHandler)
    server_thread = threading.Thread(target=test_server.serve_forever, daemon=True)
    server_thread.start()
    
    result = ""
    try:
        proxy_str = proxy_template.replace("{{port}}", str(test_port))
        for server in servers:
            server_base_url = str(server.get("base_url", "/"))
            server_port = server.get("port", 8888)
            server_token = server.get("token", "")
            proxy_url = f"http://127.0.0.1:{server_port}{server_base_url}{proxy_str}"
            if server_token:
                proxy_url += f"?token={server_token}"
            try:
                with urlopen(proxy_url, timeout=2) as resp:
                    if resp.status == 200:
                        result = server_base_url + proxy_template
                        break
            except (URLError, OSError):
                continue
    finally:
        # 异步关闭，不阻塞
        threading.Thread(target=test_server.shutdown, daemon=True).start()

    return result


def check_code_server_proxy(pids: list[int] | None = None) -> str:
    """检查Code Server代理配置
    
    Args:
        pids: 可选的 PID 列表，如果提供则只检查这些进程，否则遍历所有进程
    """
    try:
        import psutil
    except ImportError:
        return ""

    if pids:
        # 直接检查指定的 PID
        for pid in pids:
            try:
                proc = psutil.Process(pid)
                env_VSCODE_PROXY_URI = proc.environ().get("VSCODE_PROXY_URI")
                if env_VSCODE_PROXY_URI:
                    return env_VSCODE_PROXY_URI
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
    else:
        # 遍历所有进程
        for proc in psutil.process_iter(["pid", "name", "cmdline", "environ"]):  # pyright: ignore[reportUnknownMemberType]
            try:
                cmdline = proc.cmdline()
                if not cmdline:
                    continue

                cmd = " ".join(cmdline)
                if "code-server" in cmd.lower():
                    env_VSCODE_PROXY_URI = proc.environ().get("VSCODE_PROXY_URI")
                    if env_VSCODE_PROXY_URI:
                        return env_VSCODE_PROXY_URI

            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass

    return ""


class AIStudioConfigManager:
    """AI Studio配置管理器"""

    def __init__(self):
        self.config_file: str = "~/.webide/proxy_config.json"

    def update_config(self, port: int) -> None:
        """更新AI Studio配置"""
        if "STUDIO_MODEL_API_URL_PREFIX" not in os.environ:
            return

        try:
            # 展开用户目录路径
            config_file = os.path.expanduser(self.config_file)
            config: dict[str, dict[str, int]] = {"gradio": {str(port): port}}

            if os.path.exists(config_file):
                with open(config_file, "r") as f:
                    existing_config = cast(dict[str, dict[str, int]], json.load(f))
                    if "gradio" in existing_config:
                        existing_config["gradio"][str(port)] = port
                        config = existing_config
                    else:
                        config = existing_config
                        config["gradio"] = {str(port): port}

            os.makedirs(os.path.dirname(config_file), exist_ok=True)
            with open(config_file, "w") as f:
                json.dump(config, f, indent=4)

        except Exception as e:
            print(f"更新AI Studio配置失败: {e}")


# 缓存检测结果
_cached_service_config: str | None = None


def detect_service_config(use_cache: bool = True) -> str:
    """检测服务配置，返回子路径最短的URL模板
    
    Args:
        use_cache: 是否使用缓存，默认True。首次调用会执行检测并缓存结果。
    """
    global _cached_service_config
    
    if use_cache and _cached_service_config is not None:
        return _cached_service_config
    
    url_templates: list[str] = []

    try:
        import psutil

        # 收集各服务的 PID
        jupyter_pids: set[int] = set()
        code_server_pids: set[int] = set()

        # 使用网络连接方式发现服务
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr or not conn.pid:
                continue

            try:
                proc = psutil.Process(conn.pid)
                cmdline = proc.cmdline()
                if not cmdline:
                    continue

                cmd = " ".join(cmdline).lower()

                if "jupyter-lab" in cmd:
                    jupyter_pids.add(conn.pid)
                if "code-server" in cmd:
                    code_server_pids.add(conn.pid)

            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # 按需调用检测函数
        if jupyter_pids:
            url_template = check_jupyter_proxy()
            if url_template:
                url_templates.append(url_template)
        
        if code_server_pids:
            url_template = check_code_server_proxy(pids=list(code_server_pids))
            if url_template and url_template not in url_templates:
                url_templates.append(url_template)

        # 找到子路径最短的URL模板
        if url_templates:

            def get_path_length(url_template: str) -> int:
                # 对于相对路径，直接解析
                if not url_template.startswith(("http://", "https://")):
                    parsed_path = url_template
                else:
                    parsed = urlparse(url_template)
                    parsed_path = parsed.path

                # 计算路径段数量（排除空字符串）
                path_segments = [seg for seg in parsed_path.split("/") if seg]
                return len(path_segments)

            result = min(url_templates, key=get_path_length)
        else:
            result = ""

    except ImportError:
        print("psutil不可用，使用默认配置")
        result = ""
    
    # 缓存结果
    if use_cache:
        _cached_service_config = result
    
    return result


def generate_proxy_url(port: int) -> str:
    """生成指定端口的代理URL"""
    url_template = detect_service_config()
    
    if url_template:
        # 替换模板中的端口占位符
        proxy_url = url_template.replace("{{port}}", str(port))
        
        # 如果是AI Studio环境，更新配置
        if "STUDIO_MODEL_API_URL_PREFIX" in os.environ:
            ai_studio_manager = AIStudioConfigManager()
            ai_studio_manager.update_config(port)
        
        return proxy_url
    else:
        # 返回空字符串表示没有检测到代理环境
        return ""


if __name__ == "__main__":
    # 测试服务检测功能
    url_template = detect_service_config()

    if url_template:
        print(f"url_template: {url_template}")
        # 测试生成代理URL
        test_port = 3000
        proxy_url = generate_proxy_url(test_port)
        print(f"port {test_port} proxy_url: {proxy_url}")
    else:
        print("No url_template")
