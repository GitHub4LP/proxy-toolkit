"""允许通过 python -m proxy_toolkit 启动服务"""

import asyncio
from .server import main

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
