/**
 * 命令注册
 */

import * as vscode from 'vscode';
import { SwManager } from './sw-manager';

/**
 * 从端口面板上下文获取端口号
 */
function getPortFromContext(context: any): number | null {
  // VS Code 端口面板传递的上下文格式
  if (context && typeof context === 'object') {
    // 尝试多种可能的属性名
    const port = context.port || context.localPort || context.remotePort;
    if (typeof port === 'number' && port > 0 && port <= 65535) {
      return port;
    }
  }
  return null;
}

/**
 * 注册所有命令
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  swManager: SwManager
): void {
  // Enable Subpath Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('proxy-toolkit.enableSubpath', async (portContext: any) => {
      const port = getPortFromContext(portContext);
      if (!port) {
        vscode.window.showErrorMessage('Invalid port');
        return;
      }

      try {
        await swManager.setStrategy(port, 'subpath');
        vscode.window.showInformationMessage(`Port ${port}: Subpath mode enabled`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to enable subpath mode: ${err}`);
      }
    })
  );

  // Enable Tunnel Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('proxy-toolkit.enableTunnel', async (portContext: any) => {
      const port = getPortFromContext(portContext);
      if (!port) {
        vscode.window.showErrorMessage('Invalid port');
        return;
      }

      try {
        await swManager.setStrategy(port, 'tunnel');
        vscode.window.showInformationMessage(`Port ${port}: Tunnel mode enabled`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to enable tunnel mode: ${err}`);
      }
    })
  );

  // Enable Hybrid Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('proxy-toolkit.enableHybrid', async (portContext: any) => {
      const port = getPortFromContext(portContext);
      if (!port) {
        vscode.window.showErrorMessage('Invalid port');
        return;
      }

      try {
        await swManager.setStrategy(port, 'hybrid');
        vscode.window.showInformationMessage(`Port ${port}: Hybrid mode enabled`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to enable hybrid mode: ${err}`);
      }
    })
  );

  // Disable Proxy
  context.subscriptions.push(
    vscode.commands.registerCommand('proxy-toolkit.disable', async (portContext: any) => {
      const port = getPortFromContext(portContext);
      if (!port) {
        vscode.window.showErrorMessage('Invalid port');
        return;
      }

      try {
        await swManager.unregisterSw(port);
        vscode.window.showInformationMessage(`Port ${port}: Proxy disabled`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to disable proxy: ${err}`);
      }
    })
  );
}
