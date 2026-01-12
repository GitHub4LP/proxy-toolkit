import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ILauncher } from '@jupyterlab/launcher';
import { PageConfig } from '@jupyterlab/coreutils';
import { IFrame } from '@jupyterlab/apputils';

/** 默认服务端口 */
const SERVICE_PORT = 4000;

/** 命令 ID */
const COMMAND_ID = 'proxy-toolkit:open';

/** 终端管理状态 */
let managedTerminalName: string | null = null;
let serviceStarted = false;

/**
 * 检测 jupyter-server-proxy 是否已安装
 */
function checkServerProxy(): boolean {
  const configElement = document.getElementById('jupyter-config-data');
  if (!configElement) {
    return false;
  }

  try {
    const config = JSON.parse(configElement.textContent || '{}');
    const extensions = config.federated_extensions || [];
    return extensions.some(
      (ext: { name: string }) => ext.name === '@jupyterhub/jupyter-server-proxy'
    );
  } catch {
    return false;
  }
}

/**
 * 获取 XSRF token
 */
function getXsrfToken(): string {
  const match = document.cookie
    .split(';')
    .find(c => c.trim().startsWith('_xsrf='));
  return match ? match.split('=')[1] : '';
}

/**
 * 获取 proxy URL
 */
function getProxyUrl(port: number): string {
  const baseUrl = PageConfig.getBaseUrl();
  return `${baseUrl}proxy/${port}/`;
}

/**
 * 检测服务是否已运行
 */
async function isServiceRunning(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(getProxyUrl(port), {
      method: 'HEAD',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * 删除终端
 */
async function deleteTerminal(name: string): Promise<void> {
  const baseUrl = PageConfig.getBaseUrl();
  const xsrf = getXsrfToken();

  try {
    await fetch(`${baseUrl}api/terminals/${name}`, {
      method: 'DELETE',
      headers: { 'X-XSRFToken': xsrf }
    });
  } catch {
    // 忽略删除失败
  }
}

/**
 * 通过 Terminal API 启动后端服务
 */
async function startService(port: number): Promise<boolean> {
  // 如果服务已启动，直接返回
  if (serviceStarted && (await isServiceRunning(port))) {
    console.log('Service already running');
    return true;
  }

  const baseUrl = PageConfig.getBaseUrl();
  const xsrf = getXsrfToken();

  // 如果有旧终端，先删除
  if (managedTerminalName) {
    await deleteTerminal(managedTerminalName);
    managedTerminalName = null;
  }

  // 创建终端
  const termResponse = await fetch(`${baseUrl}api/terminals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRFToken': xsrf
    }
  });

  if (!termResponse.ok) {
    console.error('Failed to create terminal:', termResponse.status);
    return false;
  }

  const terminal = await termResponse.json();
  managedTerminalName = terminal.name;

  // WebSocket 连接
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // baseUrl 可能是相对路径或完整 URL，需要正确处理
  let wsUrl: string;
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    // 完整 URL，替换协议
    wsUrl = baseUrl.replace(/^https?:/, wsProtocol) + `terminals/websocket/${managedTerminalName}`;
  } else {
    // 相对路径
    wsUrl = `${wsProtocol}//${window.location.host}${baseUrl}terminals/websocket/${managedTerminalName}`;
  }

  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    ws.onopen = () => {
      // 发送启动命令（后台运行）- 使用 proxy_toolkit 包
      const cmd = `python -m proxy_toolkit --port ${port} &\r`;
      ws.send(JSON.stringify(['stdin', cmd]));
    };

    ws.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data[0] === 'stdout' && data[1].includes('启动')) {
          if (!resolved) {
            resolved = true;
            serviceStarted = true;
            ws.close();
            resolve(true);
          }
        }
      } catch {
        // ignore
      }
    };

    // 超时处理
    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        ws.close();
        // 即使没收到启动消息，也检查服务是否可用
        const running = await isServiceRunning(port);
        if (running) {
          serviceStarted = true;
        }
        resolve(running);
      }
    }, 5000);
  });
}

/**
 * 创建 IFrame Widget
 */
function createWidget(port: number): IFrame {
  const widget = new IFrame({
    sandbox: [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-popups',
      'allow-modals'
    ]
  });

  widget.url = getProxyUrl(port);
  widget.title.label = 'Proxy Toolkit';
  widget.title.closable = true;
  widget.id = 'proxy-toolkit-widget';

  return widget;
}

/**
 * 扩展插件定义
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-proxy-toolkit:plugin',
  description: 'Port proxy management with Service Worker support',
  autoStart: true,
  optional: [ILauncher],
  activate: (app: JupyterFrontEnd, launcher: ILauncher | null) => {
    console.log('JupyterLab Proxy Toolkit is activating...');

    // 检测 jupyter-server-proxy
    const hasServerProxy = checkServerProxy();
    if (!hasServerProxy) {
      console.warn(
        'jupyter-server-proxy not found. Proxy Toolkit requires jupyter-server-proxy to be installed and enabled. Please install it and restart JupyterLab.'
      );

      // 注册一个提示命令
      app.commands.addCommand(COMMAND_ID, {
        label: 'Proxy Toolkit (Unavailable)',
        caption:
          'jupyter-server-proxy is required. Please install it and restart JupyterLab.',
        isEnabled: () => false,
        execute: () => {
          // 不执行任何操作
        }
      });

      // 仍然添加到 Launcher，但显示为不可用
      if (launcher) {
        launcher.add({
          command: COMMAND_ID,
          category: 'Other',
          rank: 0
        });
      }

      return;
    }

    console.log('jupyter-server-proxy detected, registering commands...');

    // 注册命令
    app.commands.addCommand(COMMAND_ID, {
      label: 'Proxy Toolkit',
      caption: 'Open Port Proxy Management UI',
      execute: async () => {
        // 检查是否已有 widget
        const existingWidget = Array.from(app.shell.widgets('main')).find(
          w => w.id === 'proxy-toolkit-widget'
        );
        if (existingWidget) {
          app.shell.activateById('proxy-toolkit-widget');
          return;
        }

        // 检测服务是否运行
        let running = await isServiceRunning(SERVICE_PORT);

        if (!running) {
          console.log('Starting Proxy Toolkit service...');
          running = await startService(SERVICE_PORT);
        } else {
          serviceStarted = true;
        }

        if (!running) {
          console.error('Failed to start Proxy Toolkit service');
          // 仍然尝试打开，可能服务已经在运行
        }

        // 创建并显示 Widget
        const widget = createWidget(SERVICE_PORT);
        app.shell.add(widget, 'main');
        app.shell.activateById(widget.id);
      }
    });

    // 添加到 Launcher
    if (launcher) {
      launcher.add({
        command: COMMAND_ID,
        category: 'Other',
        rank: 0
      });
    }

    // 页面卸载时清理终端（可选）
    window.addEventListener('beforeunload', () => {
      if (managedTerminalName) {
        // 使用 sendBeacon 发送删除请求（不阻塞页面关闭）
        const baseUrl = PageConfig.getBaseUrl();
        navigator.sendBeacon(
          `${baseUrl}api/terminals/${managedTerminalName}?_method=DELETE`
        );
      }
    });

    console.log('JupyterLab Proxy Toolkit activated');
  }
};

export default plugin;
