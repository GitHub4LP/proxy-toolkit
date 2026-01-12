/**
 * Service Worker 管理器
 * 通过隐藏 Webview 注册和配置 SW
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SwServer } from './sw-server';
import { getProxyUrlTemplate, generateProxyUrl } from './proxy-url-resolver';

interface SwState {
  port: number;
  strategy: string;
  scope: string;
}

export class SwManager {
  private webviewPanel: vscode.WebviewPanel | null = null;
  private swStates: Map<number, SwState> = new Map();
  private pendingOperations: Map<string, { resolve: (value?: any) => void; reject: (err: Error) => void }> = new Map();
  private initPromise: Promise<void> | null = null;
  private sessionActive: boolean = false;

  constructor(
    private context: vscode.ExtensionContext,
    private swServer: SwServer
  ) {}

  /**
   * 开启会话（手动控制 Webview 生命周期）
   */
  async openSession(): Promise<void> {
    this.sessionActive = true;
    await this.ensureWebview();
  }

  /**
   * 关闭会话
   */
  closeSession(): void {
    this.sessionActive = false;
    this.closeWebview();
  }

  /**
   * 关闭 Webview
   */
  private closeWebview(): void {
    if (this.webviewPanel) {
      this.webviewPanel.dispose();
      this.webviewPanel = null;
      this.initPromise = null;
    }
  }

  /**
   * 初始化 Webview（延迟创建）
   */
  private async ensureWebview(): Promise<void> {
    if (this.webviewPanel) {
      return;
    }

    // 防止并发初始化
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.createWebview();
    return this.initPromise;
  }

  private async createWebview(): Promise<void> {
    // 创建 Webview
    this.webviewPanel = vscode.window.createWebviewPanel(
      'proxyToolkitSw',
      'Proxy Toolkit',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))
        ]
      }
    );

    // 设置 Webview 内容
    this.webviewPanel.webview.html = this.getWebviewContent();

    // 监听消息
    this.webviewPanel.webview.onDidReceiveMessage(
      (message) => this.handleWebviewMessage(message),
      undefined,
      this.context.subscriptions
    );

    // 监听关闭（用户手动关闭时清理状态）
    this.webviewPanel.onDidDispose(() => {
      this.webviewPanel = null;
      this.initPromise = null;
      // 清理所有 pending 操作
      for (const [id, { reject }] of this.pendingOperations) {
        reject(new Error('Webview disposed'));
      }
      this.pendingOperations.clear();
    });

    // 等待 Webview 就绪（包括编码检测，由 sw_client.js 处理缓存）
    await this.waitForWebviewReady();
  }

  private getWebviewContent(): string {
    const template = getProxyUrlTemplate();
    const swServerPort = this.swServer.port;

    // 构建 SW 脚本 URL（通过代理访问）
    const swScriptBase = template 
      ? generateProxyUrl(template, swServerPort)
      : `http://localhost:${swServerPort}`;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${swScriptBase}; connect-src *;">
</head>
<body>
  <script src="${swScriptBase}/sw_client.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const swScriptBase = '${swScriptBase}';
    const testEndpoint = swScriptBase + '/api/test-encoding';

    // 消息处理
    window.addEventListener('message', async (event) => {
      const message = event.data;
      
      switch (message.type) {
        case 'preRegisterSw': {
          // 只注册 SW，不配置策略（用于预注册）
          try {
            const swScriptUrl = swScriptBase + '/unified_service_worker.js';
            await SwClient.registerServiceWorker(swScriptUrl, message.scope);
            vscode.postMessage({ type: 'preRegisterResult', success: true, id: message.id });
          } catch (err) {
            console.error('SW pre-registration failed:', err);
            vscode.postMessage({ type: 'preRegisterResult', success: false, id: message.id });
          }
          break;
        }

        case 'registerSw': {
          try {
            const encoding = await SwClient.detectProxyEncoding(testEndpoint);
            const swScriptUrl = swScriptBase + '/unified_service_worker.js';
            const registration = await SwClient.registerServiceWorker(swScriptUrl, message.scope);
            if (registration.active) {
              SwClient.configureServiceWorker(registration.active, {
                strategy: message.strategy,
                decodeDepth: encoding.decodeDepth,
                slashExtraDecoding: encoding.slashExtraDecoding
              });
            }
            vscode.postMessage({ type: 'registerResult', success: true, id: message.id });
          } catch (err) {
            console.error('SW registration failed:', err);
            vscode.postMessage({ type: 'registerResult', success: false, id: message.id });
          }
          break;
        }
          
        case 'unregisterSw': {
          const success = await SwClient.unregisterServiceWorker(message.scope);
          vscode.postMessage({ type: 'unregisterResult', success, id: message.id });
          break;
        }
          
        case 'configureSw': {
          try {
            const encoding = await SwClient.detectProxyEncoding(testEndpoint);
            const registrations = await SwClient.getRegistrations();
            const targetScope = SwClient.normalizeUrl(message.scope);
            let success = false;
            for (const reg of registrations) {
              if (SwClient.normalizeUrl(reg.scope) === targetScope && reg.active) {
                SwClient.configureServiceWorker(reg.active, {
                  strategy: message.strategy,
                  decodeDepth: encoding.decodeDepth,
                  slashExtraDecoding: encoding.slashExtraDecoding
                });
                success = true;
                break;
              }
            }
            vscode.postMessage({ type: 'configureResult', success, id: message.id });
          } catch (err) {
            console.error('SW configuration failed:', err);
            vscode.postMessage({ type: 'configureResult', success: false, id: message.id });
          }
          break;
        }
          
        case 'querySwConfig': {
          try {
            const registrations = await SwClient.getRegistrations();
            const targetScope = SwClient.normalizeUrl(message.scope);
            let config = null;
            for (const reg of registrations) {
              if (SwClient.normalizeUrl(reg.scope) === targetScope && reg.active) {
                config = await SwClient.getServiceWorkerConfig(reg.active);
                break;
              }
            }
            vscode.postMessage({ type: 'queryResult', data: config, id: message.id });
          } catch (err) {
            console.error('SW query failed:', err);
            vscode.postMessage({ type: 'queryResult', data: null, id: message.id });
          }
          break;
        }
      }
    });

    // 立即通知就绪，编码检测后台预热（不阻塞）
    vscode.postMessage({ type: 'ready' });
    SwClient.detectProxyEncoding(testEndpoint);
  </script>
</body>
</html>`;
  }

  private waitForWebviewReady(): Promise<void> {
    return new Promise((resolve) => {
      const disposable = this.webviewPanel!.webview.onDidReceiveMessage((message) => {
        if (message.type === 'ready') {
          disposable.dispose();
          resolve();
        }
      });
    });
  }

  private handleWebviewMessage(message: any): void {
    const id = message.id;
    if (id && this.pendingOperations.has(id)) {
      const { resolve, reject } = this.pendingOperations.get(id)!;
      this.pendingOperations.delete(id);

      if (message.type === 'queryResult') {
        resolve(message.data);
      } else if (message.type === 'preRegisterResult' || message.type === 'registerResult' || message.type === 'unregisterResult' || message.type === 'configureResult') {
        if (message.success) {
          resolve();
        } else {
          reject(new Error('Operation failed'));
        }
      }
    }
  }

  private sendToWebview(message: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = Date.now().toString() + Math.random().toString(36);
      message.id = id;
      this.pendingOperations.set(id, { resolve, reject });
      this.webviewPanel!.webview.postMessage(message);

      setTimeout(() => {
        if (this.pendingOperations.has(id)) {
          this.pendingOperations.delete(id);
          reject(new Error('Operation timeout'));
        }
      }, 10000);
    });
  }

  private sendToWebviewWithResult<T>(message: any): Promise<T | null> {
    return new Promise((resolve) => {
      const id = Date.now().toString() + Math.random().toString(36);
      message.id = id;
      this.pendingOperations.set(id, { resolve: resolve as any, reject: () => resolve(null) });
      this.webviewPanel!.webview.postMessage(message);

      setTimeout(() => {
        if (this.pendingOperations.has(id)) {
          this.pendingOperations.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  /**
   * 注册 SW
   */
  async registerSw(targetPort: number, strategy: string): Promise<void> {
    await this.ensureWebview();

    const template = getProxyUrlTemplate();
    if (!template) {
      throw new Error('No proxy URL template');
    }

    let scope = generateProxyUrl(template, targetPort);
    if (!scope.endsWith('/')) {
      scope += '/';
    }

    try {
      await this.sendToWebview({
        type: 'registerSw',
        scope,
        strategy
      });
      this.swStates.set(targetPort, { port: targetPort, strategy, scope });
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }
  }

  /**
   * 注销 SW
   */
  async unregisterSw(targetPort: number): Promise<void> {
    const state = this.swStates.get(targetPort);
    if (!state) {
      return;
    }

    await this.ensureWebview();
    try {
      await this.sendToWebview({ type: 'unregisterSw', scope: state.scope });
      this.swStates.delete(targetPort);
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }
  }

  /**
   * 设置策略
   */
  async setStrategy(targetPort: number, strategy: string): Promise<void> {
    const state = this.swStates.get(targetPort);
    
    if (!state) {
      await this.registerSw(targetPort, strategy);
      return;
    }

    await this.ensureWebview();
    try {
      await this.sendToWebview({
        type: 'configureSw',
        scope: state.scope,
        strategy
      });
      state.strategy = strategy;
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }
  }

  /**
   * 获取端口状态
   */
  getState(targetPort: number): SwState | undefined {
    return this.swStates.get(targetPort);
  }

  /**
   * 预注册 SW（只注册，不配置策略）
   * 用于在用户选择前后台预热
   */
  async preRegister(targetPort: number): Promise<void> {
    const template = getProxyUrlTemplate();
    if (!template) {
      throw new Error('No proxy URL template');
    }

    let scope = generateProxyUrl(template, targetPort);
    if (!scope.endsWith('/')) {
      scope += '/';
    }

    // 如果已经注册过，跳过
    if (this.swStates.has(targetPort)) {
      return;
    }

    await this.ensureWebview();
    try {
      await this.sendToWebview({
        type: 'preRegisterSw',
        scope
      });
      // 预注册成功，记录状态（策略为 none）
      this.swStates.set(targetPort, { port: targetPort, strategy: 'none', scope });
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }
  }

  /**
   * 配置已注册 SW 的策略
   */
  async configureStrategy(targetPort: number, strategy: string): Promise<void> {
    const state = this.swStates.get(targetPort);
    if (!state) {
      // 未注册，走完整注册流程
      await this.registerSw(targetPort, strategy);
      return;
    }

    await this.ensureWebview();
    try {
      await this.sendToWebview({
        type: 'configureSw',
        scope: state.scope,
        strategy
      });
      state.strategy = strategy;
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }
  }

  /**
   * 查询端口的实际策略（从 SW 查询）
   */
  async getStrategy(targetPort: number): Promise<string> {
    const template = getProxyUrlTemplate();
    if (!template) {
      return 'none';
    }

    let scope = generateProxyUrl(template, targetPort);
    if (!scope.endsWith('/')) {
      scope += '/';
    }

    try {
      await this.ensureWebview();
      
      interface SwConfig {
        strategy: string;
        decodeDepth: number;
        slashExtraDecoding: boolean;
      }
      
      const config = await this.sendToWebviewWithResult<SwConfig>({
        type: 'querySwConfig',
        scope
      });

      if (config && config.strategy) {
        const state = this.swStates.get(targetPort);
        if (state) {
          state.strategy = config.strategy;
        } else if (config.strategy !== 'none') {
          this.swStates.set(targetPort, { port: targetPort, strategy: config.strategy, scope });
        }
        return config.strategy;
      }
    } catch (err) {
      console.warn(`[SW Manager] Failed to query strategy for port ${targetPort}:`, err);
    } finally {
      if (!this.sessionActive) {
        this.closeWebview();
      }
    }

    const state = this.swStates.get(targetPort);
    return state?.strategy || 'none';
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.webviewPanel) {
      this.webviewPanel.dispose();
      this.webviewPanel = null;
    }
  }
}
