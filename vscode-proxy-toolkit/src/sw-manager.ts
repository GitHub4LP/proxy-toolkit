/**
 * Service Worker 管理器
 * 通过隐藏 Webview 注册和配置 SW
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
  private encodingConfig: { decodeDepth: number; slashExtraDecoding: boolean } | null = null;
  private pendingOperations: Map<string, { resolve: () => void; reject: (err: Error) => void }> = new Map();

  constructor(
    private context: vscode.ExtensionContext,
    private swServer: SwServer
  ) {}

  /**
   * 初始化 Webview（延迟创建）
   */
  private async ensureWebview(): Promise<void> {
    if (this.webviewPanel) {
      return;
    }

    // 创建隐藏的 Webview
    this.webviewPanel = vscode.window.createWebviewPanel(
      'proxyToolkitSw',
      'Proxy Toolkit SW',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))
        ]
      }
    );

    // 隐藏面板（最小化干扰）
    // 注意：VS Code 没有直接隐藏 Webview 的 API，但 retainContextWhenHidden 可以保持后台运行

    // 设置 Webview 内容
    this.webviewPanel.webview.html = this.getWebviewContent();

    // 监听消息
    this.webviewPanel.webview.onDidReceiveMessage(
      (message) => this.handleWebviewMessage(message),
      undefined,
      this.context.subscriptions
    );

    // 监听关闭
    this.webviewPanel.onDidDispose(() => {
      this.webviewPanel = null;
    });

    // 等待 Webview 就绪
    await this.waitForWebviewReady();

    // 检测编码
    await this.detectEncoding();
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
  <script>
    const vscode = acquireVsCodeApi();
    const swScriptBase = '${swScriptBase}';
    const testEndpoint = swScriptBase + '/api/test-encoding';

    // 编码检测
    async function detectProxyEncoding() {
      const result = { decodeDepth: 0, slashExtraDecoding: false };

      try {
        const testSegment = "test path";
        let maxLayers = 4;
        const maxAttempts = 8;
        const baseEncoded = encodeURIComponent(testSegment);

        while (maxLayers <= maxAttempts) {
          let encodedSegment = baseEncoded;
          for (let i = 0; i < maxLayers; i++) {
            encodedSegment = encodeURIComponent(encodedSegment);
          }

          const response = await fetch(testEndpoint + '/' + encodedSegment);
          if (!response.ok) break;

          const data = await response.json();
          let current = data.path;
          let encodeSteps = 0;

          while (current !== encodedSegment && encodeSteps < maxLayers) {
            current = encodeURIComponent(current);
            encodeSteps++;
          }

          const detectedDepth = (current === encodedSegment) ? encodeSteps : 0;
          
          // 验证
          let verifySegment = baseEncoded;
          for (let i = 0; i < detectedDepth; i++) {
            verifySegment = encodeURIComponent(verifySegment);
          }
          const verifyResponse = await fetch(testEndpoint + '/' + verifySegment);
          if (verifyResponse.ok) {
            const verifyData = await verifyResponse.json();
            if (verifyData.path === baseEncoded) {
              result.decodeDepth = detectedDepth;
              break;
            }
          }
          maxLayers++;
        }

        // 检测 %2F 额外解码
        if (result.decodeDepth >= 0) {
          const slashTest = "test/path";
          const slashEncoded = encodeURIComponent(slashTest);
          let encoded = slashEncoded;
          for (let i = 0; i < result.decodeDepth; i++) {
            encoded = encodeURIComponent(encoded);
          }
          const slashResponse = await fetch(testEndpoint + '/' + encoded);
          if (slashResponse.ok) {
            const slashData = await slashResponse.json();
            const pathParts = slashData.path.split('/');
            result.slashExtraDecoding = pathParts.filter(p => p !== '').length > 1;
          }
        }
      } catch (err) {
        console.warn('Encoding detection failed:', err);
      }

      return result;
    }

    // SW 注册
    async function registerSw(scope, strategy, config) {
      try {
        const swScriptUrl = swScriptBase + '/unified_service_worker.js';
        const registration = await navigator.serviceWorker.register(swScriptUrl, { scope });

        // 等待激活
        if (registration.installing) {
          await new Promise(resolve => {
            registration.installing.addEventListener('statechange', function() {
              if (this.state === 'activated' || this.state === 'redundant') {
                resolve();
              }
            });
            setTimeout(resolve, 5000);
          });
        }

        // 配置
        if (registration.active) {
          registration.active.postMessage({
            type: 'CONFIGURE',
            data: {
              strategy: strategy,
              decodeDepth: config.decodeDepth,
              slashExtraDecoding: config.slashExtraDecoding
            }
          });
        }

        return true;
      } catch (err) {
        console.error('SW registration failed:', err);
        return false;
      }
    }

    // SW 注销
    async function unregisterSw(scope) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          const regScope = new URL(reg.scope).pathname;
          const targetScope = scope.startsWith('/') ? scope : new URL(scope).pathname;
          if (regScope === targetScope) {
            await reg.unregister();
            return true;
          }
        }
        return false;
      } catch (err) {
        console.error('SW unregistration failed:', err);
        return false;
      }
    }

    // 配置 SW
    async function configureSw(scope, strategy, config) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          const regScope = new URL(reg.scope).pathname;
          const targetScope = scope.startsWith('/') ? scope : new URL(scope).pathname;
          if (regScope === targetScope && reg.active) {
            reg.active.postMessage({
              type: 'CONFIGURE',
              data: {
                strategy: strategy,
                decodeDepth: config.decodeDepth,
                slashExtraDecoding: config.slashExtraDecoding
              }
            });
            return true;
          }
        }
        return false;
      } catch (err) {
        console.error('SW configuration failed:', err);
        return false;
      }
    }

    // 消息处理
    window.addEventListener('message', async (event) => {
      const message = event.data;
      
      switch (message.type) {
        case 'detectEncoding':
          const encoding = await detectProxyEncoding();
          vscode.postMessage({ type: 'encodingResult', data: encoding, id: message.id });
          break;
          
        case 'registerSw':
          const regResult = await registerSw(message.scope, message.strategy, message.config);
          vscode.postMessage({ type: 'registerResult', success: regResult, id: message.id });
          break;
          
        case 'unregisterSw':
          const unregResult = await unregisterSw(message.scope);
          vscode.postMessage({ type: 'unregisterResult', success: unregResult, id: message.id });
          break;
          
        case 'configureSw':
          const configResult = await configureSw(message.scope, message.strategy, message.config);
          vscode.postMessage({ type: 'configureResult', success: configResult, id: message.id });
          break;
      }
    });

    // 通知就绪
    vscode.postMessage({ type: 'ready' });
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

      if (message.type === 'encodingResult') {
        this.encodingConfig = message.data;
        resolve();
      } else if (message.type === 'registerResult' || message.type === 'unregisterResult' || message.type === 'configureResult') {
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

      // 超时
      setTimeout(() => {
        if (this.pendingOperations.has(id)) {
          this.pendingOperations.delete(id);
          reject(new Error('Operation timeout'));
        }
      }, 10000);
    });
  }

  private async detectEncoding(): Promise<void> {
    await this.sendToWebview({ type: 'detectEncoding' });
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

    await this.sendToWebview({
      type: 'registerSw',
      scope,
      strategy,
      config: this.encodingConfig || { decodeDepth: 0, slashExtraDecoding: false }
    });

    this.swStates.set(targetPort, { port: targetPort, strategy, scope });
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
    await this.sendToWebview({ type: 'unregisterSw', scope: state.scope });
    this.swStates.delete(targetPort);
  }

  /**
   * 设置策略
   */
  async setStrategy(targetPort: number, strategy: string): Promise<void> {
    const state = this.swStates.get(targetPort);
    
    if (!state) {
      // 未注册，先注册
      await this.registerSw(targetPort, strategy);
      return;
    }

    await this.ensureWebview();
    await this.sendToWebview({
      type: 'configureSw',
      scope: state.scope,
      strategy,
      config: this.encodingConfig || { decodeDepth: 0, slashExtraDecoding: false }
    });

    state.strategy = strategy;
  }

  /**
   * 获取端口状态
   */
  getState(targetPort: number): SwState | undefined {
    return this.swStates.get(targetPort);
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
