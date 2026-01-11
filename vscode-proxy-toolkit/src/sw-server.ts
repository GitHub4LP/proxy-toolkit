/**
 * SW 脚本 HTTP 服务
 * 提供 SW 脚本、编码检测端点、HTTP 隧道
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class SwServer {
  private server: http.Server | null = null;
  private _port: number = 0;
  private resourcesDir: string;

  constructor(private context: vscode.ExtensionContext) {
    this.resourcesDir = path.join(context.extensionPath, 'resources');
  }

  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // 监听 localhost 动态端口
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          console.log(`[SW Server] Started on port ${this._port}`);
          resolve();
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (err) => {
        console.error('[SW Server] Error:', err);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this._port = 0;
        console.log('[SW Server] Stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this._port}`);
    const pathname = url.pathname;

    // 路由
    if (pathname === '/unified_service_worker.js') {
      this.serveFile(res, 'unified_service_worker.js', true);
    } else if (pathname === '/navigation_interceptor.js') {
      this.serveFile(res, 'navigation_interceptor.js', false);
    } else if (pathname === '/sw_client.js') {
      this.serveFile(res, 'sw_client.js', false);
    } else if (pathname.startsWith('/api/test-encoding/')) {
      this.handleTestEncoding(req, res, pathname);
    } else if (pathname.startsWith('/api/http-tunnel/')) {
      this.handleHttpTunnel(req, res, url);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private serveFile(res: http.ServerResponse, filename: string, isServiceWorker: boolean): void {
    const filePath = path.join(this.resourcesDir, filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      };

      if (isServiceWorker) {
        headers['Service-Worker-Allowed'] = '/';
      }

      res.writeHead(200, headers);
      res.end(content);
    } catch (err) {
      console.error(`[SW Server] File not found: ${filename}`);
      res.writeHead(404);
      res.end('File not found');
    }
  }

  private handleTestEncoding(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    // 提取测试路径部分（原始未解码）
    const prefix = '/api/test-encoding/';
    const rawUrl = req.url || '';
    const prefixIndex = rawUrl.indexOf(prefix);
    const testPath = prefixIndex >= 0 ? rawUrl.substring(prefixIndex + prefix.length) : '';

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ path: testPath }));
  }

  private handleHttpTunnel(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    // 提取目标端口
    const portMatch = url.pathname.match(/^\/api\/http-tunnel\/(\d+)/);
    if (!portMatch) {
      res.writeHead(400);
      res.end('Invalid port');
      return;
    }

    const targetPort = parseInt(portMatch[1]);
    if (targetPort <= 0 || targetPort > 65535) {
      res.writeHead(400);
      res.end('Invalid port range');
      return;
    }

    // 获取目标路径
    const targetPath = url.searchParams.get('u');
    if (!targetPath || !targetPath.startsWith('/')) {
      res.writeHead(400);
      res.end('Missing or invalid parameter u');
      return;
    }

    // 构建目标 URL
    const targetUrl = `http://localhost:${targetPort}${targetPath}`;

    // 过滤请求头
    const skipHeaders = new Set([
      'host', 'content-length', 'connection', 'upgrade',
      'proxy-connection', 'proxy-authorization', 'transfer-encoding'
    ]);

    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (!skipHeaders.has(lowerKey) && !lowerKey.startsWith('x-forwarded-') && !lowerKey.startsWith('x-proxy')) {
        headers[key] = value;
      }
    }

    // 重写来源头
    const targetOrigin = `http://localhost:${targetPort}`;
    headers['Origin'] = targetOrigin;
    headers['Referer'] = targetOrigin + '/';

    // 发起代理请求
    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers
    }, (proxyRes) => {
      // 过滤响应头
      const respHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== 'transfer-encoding' && lowerKey !== 'connection' && lowerKey !== 'content-length') {
          respHeaders[key] = value;
        }
      }

      res.writeHead(proxyRes.statusCode || 502, respHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[SW Server] Tunnel error:', err);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
      }
    });

    // 转发请求体
    req.pipe(proxyReq);
  }
}
