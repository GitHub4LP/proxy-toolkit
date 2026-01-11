/**
 * VS Code Proxy Toolkit 扩展入口
 */

import * as vscode from 'vscode';
import { shouldEnable, getProxyUrlTemplate } from './proxy-url-resolver';
import { SwServer } from './sw-server';
import { SwManager } from './sw-manager';
import { registerCommands } from './commands';

let swServer: SwServer | null = null;
let swManager: SwManager | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Proxy Toolkit] Activating...');

  // 检测是否应该启用
  if (!shouldEnable()) {
    const template = getProxyUrlTemplate();
    if (!template) {
      console.log('[Proxy Toolkit] VSCODE_PROXY_URI not set, disabled');
    } else {
      console.log('[Proxy Toolkit] No subpath in template, disabled');
    }
    // 设置上下文变量，隐藏菜单
    await vscode.commands.executeCommand('setContext', 'proxyToolkit.enabled', false);
    return;
  }

  console.log('[Proxy Toolkit] Subpath environment detected, enabling...');

  try {
    // 启动 SW 脚本服务
    swServer = new SwServer(context);
    await swServer.start();
    console.log(`[Proxy Toolkit] SW Server started on port ${swServer.port}`);

    // 创建 SW 管理器
    swManager = new SwManager(context, swServer);

    // 注册命令
    registerCommands(context, swManager);

    // 设置上下文变量，显示菜单
    await vscode.commands.executeCommand('setContext', 'proxyToolkit.enabled', true);

    console.log('[Proxy Toolkit] Activated successfully');
  } catch (err) {
    console.error('[Proxy Toolkit] Activation failed:', err);
    vscode.window.showErrorMessage(`Proxy Toolkit activation failed: ${err}`);
  }
}

export async function deactivate(): Promise<void> {
  console.log('[Proxy Toolkit] Deactivating...');

  // 清理 SW 管理器
  if (swManager) {
    swManager.dispose();
    swManager = null;
  }

  // 停止 SW 服务
  if (swServer) {
    await swServer.stop();
    swServer = null;
  }

  console.log('[Proxy Toolkit] Deactivated');
}
