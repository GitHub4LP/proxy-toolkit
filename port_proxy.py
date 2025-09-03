import os
from typing import Callable, cast
import json
from urllib.parse import urlparse


def check_jupyter_proxy() -> str:
    """检查JupyterLab代理配置"""

    if "STUDIO_MODEL_API_URL_PREFIX" in os.environ:  # AI Studio
        protocol_host = os.environ["STUDIO_MODEL_API_URL_PREFIX"]
        path_template = os.environ["JUPYTERHUB_SERVICE_PREFIX"] + r"gradio/{{port}}/"
        if protocol_host:
            return protocol_host + path_template
        else:
            return ""

    try:
        from jupyter_server import serverapp
    except ImportError:
        return ""

    servers = list(serverapp.list_running_servers())
    if not servers:
        return ""

    try:
        import requests
    except ImportError:
        return ""

    proxy_template = r"proxy/{{port}}/"
    port = 65534
    proxy_str = proxy_template.replace("{{port}}", str(port))
    for server in servers:  # pyright: ignore[reportAny]
        server_base_url: str = server["base_url"]  # pyright: ignore[reportAny]
        local_url = f"http://127.0.0.1:{server['port']}{server_base_url}{proxy_str}?token={server['token']}"
        try:
            resp = requests.get(local_url, timeout=5)
            if 500 <= resp.status_code < 600:
                return server_base_url + proxy_template
        except requests.exceptions.RequestException:
            continue

    return ""


def check_code_server_proxy() -> str:
    """检查Code Server代理配置"""
    try:
        import psutil
    except ImportError:
        return ""

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
        self.config_file: str = "/home/aistudio/.gradio/config.json"

    def update_config(self, port: int) -> None:
        """更新AI Studio配置"""
        if "STUDIO_MODEL_API_URL_PREFIX" not in os.environ:
            return

        try:
            config: dict[str, dict[str, int]] = {"gradio": {str(port): port}}

            if os.path.exists(self.config_file):
                with open(self.config_file, "r") as f:
                    existing_config = cast(dict[str, dict[str, int]], json.load(f))
                    if "gradio" in existing_config:
                        existing_config["gradio"][str(port)] = port
                        config = existing_config
                    else:
                        config = existing_config
                        config["gradio"] = {str(port): port}

            os.makedirs(os.path.dirname(self.config_file), exist_ok=True)
            with open(self.config_file, "w") as f:
                json.dump(config, f, indent=4)

        except Exception as e:
            print(f"更新AI Studio配置失败: {e}")


def detect_service_config() -> str:
    """检测服务配置，返回子路径最短的URL模板"""
    url_templates: list[str] = []

    # 服务检测配置
    service_configs: dict[str, Callable[[], str]] = {
        "jupyter-lab": check_jupyter_proxy,
        "code-server": check_code_server_proxy,
    }

    try:
        import psutil

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

                # 检测各种服务
                for service_name, config_func in service_configs.items():
                    if service_name in cmd:
                        url_template = config_func()
                        if url_template and url_template not in url_templates:
                            url_templates.append(url_template)

            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

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

            return min(url_templates, key=get_path_length)
        else:
            return ""

    except ImportError:
        print("psutil不可用，使用默认配置")
        return ""


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
