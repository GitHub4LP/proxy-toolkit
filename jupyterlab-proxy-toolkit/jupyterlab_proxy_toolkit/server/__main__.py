"""Entry point for running server as module: python -m jupyterlab_proxy_toolkit.server"""

import asyncio
from .server import main

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
