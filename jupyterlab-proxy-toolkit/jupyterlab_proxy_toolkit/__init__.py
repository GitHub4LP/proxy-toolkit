"""JupyterLab Proxy Toolkit Extension"""

# 从 proxy-toolkit 包导入
from proxy_toolkit import __version__


def _jupyter_labextension_paths():
    """Return the paths to the JupyterLab extension."""
    return [{"src": "labextension", "dest": "jupyterlab-proxy-toolkit"}]
