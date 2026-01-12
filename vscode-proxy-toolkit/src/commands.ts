/**
 * 命令注册
 */

import * as vscode from 'vscode';
import { SwManager } from './sw-manager';

interface ModeOption {
  label: string;
  value: string;
  description: string;
}

/**
 * 从端口面板上下文获取端口号
 */
function getPortFromContext(context: any): number | null {
  if (context && typeof context === 'object') {
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
  // Proxy Mode 选择器
  context.subscriptions.push(
    vscode.commands.registerCommand('proxy-toolkit.selectMode', async (portContext: any) => {
      const port = getPortFromContext(portContext);
      if (!port) {
        vscode.window.showErrorMessage('Invalid port');
        return;
      }

      await swManager.openSession();
      try {
        // 从 SW 查询当前策略
        const currentMode = await swManager.getStrategy(port);

        // 如果未注册，后台预注册（不阻塞 QuickPick 显示）
        let preRegisterPromise: Promise<void> | null = null;
        if (currentMode === 'none') {
          preRegisterPromise = swManager.preRegister(port).catch(() => {});
        }

        // 定义模式选项
        const modes: ModeOption[] = [
          { label: 'None', value: 'none', description: 'Disable proxy' },
          { label: 'Subpath', value: 'subpath', description: 'Rewrite URLs for subpath proxy' },
          { label: 'Tunnel', value: 'tunnel', description: 'Direct tunnel mode' },
          { label: 'Hybrid', value: 'hybrid', description: 'Auto detect mode' }
        ];

        // 构建 QuickPick 项，当前模式显示 ✓
        const items = modes.map(mode => ({
          label: (mode.value === currentMode ? '$(check) ' : '$(blank) ') + mode.label,
          description: mode.description,
          value: mode.value
        }));

        // 显示选择器
        const selected = await vscode.window.showQuickPick(items, {
          title: `Proxy Mode for Port ${port}`,
          placeHolder: `Current: ${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}`
        });

        if (!selected) {
          return; // 用户取消
        }

        // 如果有预注册，等待完成
        if (preRegisterPromise) {
          await preRegisterPromise;
        }

        // 配置策略
        await swManager.configureStrategy(port, selected.value);
        const modeLabel = selected.value === 'none' ? 'Proxy disabled' : `${selected.value.charAt(0).toUpperCase() + selected.value.slice(1)} mode enabled`;
        vscode.window.showInformationMessage(`Port ${port}: ${modeLabel}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to set proxy mode: ${err}`);
      } finally {
        swManager.closeSession();
      }
    })
  );
}
