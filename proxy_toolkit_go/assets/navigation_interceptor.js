/**
 * 导航拦截器（纯函数闭包版）- 子路径环境下的导航修复
 * 由 Service Worker 注入到 HTML：先设置 window._NavigationInterceptorConfig = { scopeBase: '...' }，后加载本脚本
 * 仅 patch SW fetch 无法处理的：导航类 API（pushState/click/submit/popstate/window.open/Navigation API）和 WebSocket
 */

(function (global) {
  'use strict';

  function reportChange(type, original, modified, extra) {
    try {
      if (original === modified) return;
      var payload = { type: type, original: original, modified: modified };
      if (extra && typeof extra === 'object') {
        for (var k in extra) { try { payload[k] = extra[k]; } catch(_){} }
      }
      console.log('[NavFix]', payload);
    } catch (_) {}
  }

  // 读取配置（由 SW 注入）；缺失则安全退出
  var cfg = global._NavigationInterceptorConfig;
  if (!cfg || !cfg.scopeBase) {
    return;
  }

  // 规范化 scopeBase：确保以 "/" 开头、以 "/" 结尾
  var scopeBase = cfg.scopeBase;
  if (!scopeBase.startsWith('/')) scopeBase = '/' + scopeBase;
  if (!scopeBase.endsWith('/')) scopeBase += '/';

  // 捕获原方法引用
  var originalPushState = history.pushState.bind(history);
  var originalReplaceState = history.replaceState.bind(history);
  var originalOpen = global.open.bind(global);
  var originalAssign = global.location.assign.bind(global.location);
  var OrigWebSocket = global.WebSocket;

  // 统一判断：URL 是否需要重写（相对根路径 或 同源绝对 URL，且 pathname 不在 scope 内）
  function needsRewrite(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('//')) return false;
    if (/^(data:|blob:|mailto:|tel:|javascript:|about:)/i.test(url)) return false;
    if (url.startsWith('#') || url.startsWith('?')) return false;
    // 绝对 URL（http/https/ws/wss 等）
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      try {
        var u = new URL(url, global.location.href);
        if (u.host !== global.location.host) return false;
        return !u.pathname.startsWith(scopeBase);
      } catch (e) { return false; }
    }
    // 相对根路径
    if (!url.startsWith('/')) return false;
    return !url.startsWith(scopeBase);
  }

  // 统一重写：返回重写后的 URL，不需要则原样返回
  function rewriteUrl(url) {
    if (!needsRewrite(url)) return url;
    // 绝对 URL：重写 pathname，保留 search/hash 等
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      try {
        var u = new URL(url, global.location.href);
        u.pathname = scopeBase + u.pathname.substring(1);
        return u.href;
      } catch (e) { return url; }
    }
    // 相对根路径
    return scopeBase + url.substring(1);
  }

  function installInterceptors() {
    // 1) 链接点击拦截
    document.addEventListener('click', function (event) {
      try {
        var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!link) return;
        var href = link.getAttribute('href');
        if (!needsRewrite(href)) return;

        event.preventDefault();
        event.stopPropagation();

        var fixedHref = rewriteUrl(href);
        reportChange('click', href, fixedHref, { target: link.getAttribute('target') });
        var target = link.getAttribute('target');
        if (target === '_blank' || event.ctrlKey || event.metaKey) {
          originalOpen(fixedHref, target || '_blank');
        } else {
          global.location.href = fixedHref;
        }
      } catch (_) { /* 静默处理 */ }
    }, true);

    // 2) history 拦截
    history.pushState = function (state, title, url) {
      try {
        var finalUrl = rewriteUrl(url);
        reportChange('pushState', url, finalUrl);
        return originalPushState(state, title, finalUrl);
      } catch (_) {
        return originalPushState(state, title, url);
      }
    };

    history.replaceState = function (state, title, url) {
      try {
        var finalUrl = rewriteUrl(url);
        reportChange('replaceState', url, finalUrl);
        return originalReplaceState(state, title, finalUrl);
      } catch (_) {
        return originalReplaceState(state, title, url);
      }
    };

    // 3) popstate 补救
    global.addEventListener('popstate', function (event) {
      try {
        var currentPath = global.location.pathname;
        if (!needsRewrite(currentPath)) return;
        var fixedPath = rewriteUrl(currentPath) + global.location.search + global.location.hash;
        reportChange('popstate', currentPath + global.location.search + global.location.hash, fixedPath);
        originalReplaceState(event.state, '', fixedPath);
      } catch (_) { /* 静默处理 */ }
    });

    // 4) 表单提交拦截
    document.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        if (!form || form.tagName !== 'FORM') return;
        var action = form.getAttribute('action');
        if (!needsRewrite(action)) return;
        var fixedAction = rewriteUrl(action);
        reportChange('form', action, fixedAction, { method: form.method || 'GET' });
        form.setAttribute('action', fixedAction);
      } catch (_) { /* 静默处理 */ }
    }, true);

    // 5) window.open 拦截
    global.open = function (url, target, features) {
      try {
        if (url) {
          var fixed = rewriteUrl(String(url));
          reportChange('window.open', url, fixed);
          url = fixed;
        }
      } catch (_) { /* 静默处理 */ }
      return originalOpen(url, target, features);
    };

    // 6) WebSocket 拦截
    if (OrigWebSocket) {
      if (cfg.wsFallback) {
        // WS 降级模式：SSE + POST 桥接
        global.WebSocket = createWsPolyfill(rewriteUrl, reportChange);
      } else {
        // 原生模式：仅重写 URL
        global.WebSocket = function (url, protocols) {
          try {
            if (typeof url === 'string') {
              var fixed = rewriteUrl(url);
              reportChange('websocket', url, fixed);
              url = fixed;
            }
          } catch (_) { /* 静默处理 */ }
          return new OrigWebSocket(url, protocols);
        };
        global.WebSocket.prototype = OrigWebSocket.prototype;
      }
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSING = 2;
      global.WebSocket.CLOSED = 3;
    }

    // 7) Navigation API 拦截（仅 Chromium）：唯一能拦截 location.href 赋值的手段
    if (typeof navigation !== 'undefined') {
      navigation.addEventListener('navigate', function (event) {
        if (!event.canIntercept) return;
        if (event.destination.sameDocument) return;
        try {
          var destUrl = event.destination.url;
          var fixedUrl = rewriteUrl(destUrl);
          if (fixedUrl === destUrl) return;
          reportChange('nav-api', destUrl, fixedUrl);
          event.intercept({
            handler: function () {
              originalAssign(fixedUrl);
            }
          });
        } catch (_) { /* 静默处理 */ }
      });
    }
  }

  // ==================== WebSocket Polyfill (SSE + POST) ====================

  function createWsPolyfill(rewriteUrl, reportChange) {
    function WsPolyfill(url, protocols) {
      var self = this;
      self._readyState = 0; // CONNECTING
      self._sid = '';
      self._protocols = protocols;
      self.onopen = null;
      self.onmessage = null;
      self.onclose = null;
      self.onerror = null;
      self.binaryType = 'blob';

      // 重写 URL（子路径修正）
      var fixedUrl = url;
      try {
        if (typeof url === 'string') {
          fixedUrl = rewriteUrl(url);
          reportChange('websocket', url, fixedUrl);
        }
      } catch (_) {}

      // 解析目标路径和端口
      var parsed;
      try {
        parsed = new URL(fixedUrl, global.location.href);
      } catch (_) {
        self._readyState = 3; // CLOSED
        if (self.onerror) self.onerror(new Event('error'));
        return;
      }

      // 生成 sid
      self._sid = 'ws-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

      // 从配置获取桥接基路径和目标端口（由 SW 注入）
      var bridgeBase = cfg.bridgeBase || '';
      var portStr = String(cfg.targetPort || '');
      if (!portStr) {
        self._readyState = 3;
        if (self.onerror) self.onerror(new Event('error'));
        return;
      }
      self._portStr = portStr;

      // 从重写后路径中剥离 scopeBase 前缀，得到目标服务上的相对路径
      var wsPath = parsed.pathname;
      if (wsPath.startsWith(scopeBase)) {
        wsPath = '/' + wsPath.substring(scopeBase.length);
      }
      wsPath += parsed.search;

      var subprotoParam = '';
      if (protocols) {
        try { subprotoParam = '&subprotocols=' + encodeURIComponent(JSON.stringify(protocols)); } catch(_){}
      }

      var sseUrl = bridgeBase + '/proxy/' + portStr + '?u=' + encodeURIComponent(wsPath) + '&ws=1&sid=' + self._sid + subprotoParam;
      self._postUrl = bridgeBase + '/proxy/' + portStr + '?ws=1&sid=' + self._sid;
      self._url = fixedUrl;

      // 事件处理（SSE 和 Fetch Streaming 共用）
      function handleEvent(rawData) {
        try {
          var ev = JSON.parse(rawData);
          if (ev.type === 'open') {
            self._readyState = 1; // OPEN
            if (self.onopen) self.onopen(new Event('open'));
          } else if (ev.type === 'message') {
            var binary = atob(ev.data);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            var msgData = (ev.msgType === 1) ? new TextDecoder('utf-8').decode(bytes) : bytes;
            var msgEvent = new MessageEvent('message', { data: msgData });
            Object.defineProperty(msgEvent, 'data', { value: msgData });
            if (self.onmessage) self.onmessage(msgEvent);
          } else if (ev.type === 'close') {
            self._readyState = 3; // CLOSED
            if (self._eventSource) self._eventSource.close();
            if (self._readerCancel) self._readerCancel = true;
            var closeEvent = new CloseEvent('close', { code: ev.code || 1000, reason: '', wasClean: ev.code === 1000 });
            if (self.onclose) self.onclose(closeEvent);
          }
        } catch (e) {
          if (self.onerror) self.onerror(new Event('error'));
        }
      }

      // Fetch Streaming 降级
      function connectFetchStream() {
        fetch(sseUrl + '&stream=1').then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          var reader = response.body.getReader();
          var decoder = new TextDecoder('utf-8');
          var buffer = '';
          self._readerCancel = false;

          function pump() {
            reader.read().then(function (result) {
              if (result.done || self._readerCancel) return;
              buffer += decoder.decode(result.value, { stream: true });
              // 按 SSE 帧分割：data: {json}\n\n
              var parts = buffer.split('\n\n');
              buffer = parts.pop(); // 最后一段可能不完整
              for (var i = 0; i < parts.length; i++) {
                var line = parts[i].trim();
                if (line.startsWith('data: ')) {
                  handleEvent(line.substring(6));
                }
              }
              pump();
            }).catch(function () {
              if (self._readyState !== 3) {
                self._readyState = 3;
                if (self.onerror) self.onerror(new Event('error'));
                if (self.onclose) self.onclose(new CloseEvent('close', { code: 1006, wasClean: false }));
              }
            });
          }
          pump();
        }).catch(function () {
          if (self._readyState !== 3) {
            self._readyState = 3;
            if (self.onerror) self.onerror(new Event('error'));
            if (self.onclose) self.onclose(new CloseEvent('close', { code: 1006, wasClean: false }));
          }
        });
      }

      // 先尝试 SSE（EventSource）
      var es = new EventSource(sseUrl);
      self._eventSource = es;
      var sseFailed = false;

      es.onmessage = function (event) { handleEvent(event.data); };

      es.onerror = function () {
        if (self._readyState === 1) {
          // 已连接后断开，直接报错
          self._readyState = 3;
          if (self.onerror) self.onerror(new Event('error'));
          if (self.onclose) self.onclose(new CloseEvent('close', { code: 1006, wasClean: false }));
        } else if (!sseFailed) {
          // 连接阶段失败，降级到 Fetch Streaming
          sseFailed = true;
          es.close();
          connectFetchStream();
        }
      };
    }

    WsPolyfill.prototype.send = function (data) {
      if (this._readyState !== 1) return;
      var body;
      var contentType = 'text/plain';
      if (typeof data === 'string') {
        body = data;
      } else if (data instanceof ArrayBuffer) {
        body = data;
        contentType = 'application/octet-stream';
      } else if (data instanceof Blob) {
        var self = this;
        data.arrayBuffer().then(function (ab) {
          fetch(self._postUrl, { method: 'POST', body: ab, headers: { 'Content-Type': 'application/octet-stream' } });
        });
        return;
      } else {
        body = String(data);
      }
      fetch(this._postUrl, { method: 'POST', body: body, headers: { 'Content-Type': contentType } });
    };

    WsPolyfill.prototype.close = function (code, reason) {
      if (this._readyState === 3) return;
      this._readyState = 2; // CLOSING
      var self = this;
      fetch(this._postUrl + '&action=close', { method: 'POST' }).then(function () {
        self._readyState = 3;
        if (self._eventSource) self._eventSource.close();
        if (self.onclose) self.onclose(new CloseEvent('close', { code: code || 1000, wasClean: true }));
      }).catch(function () {
        self._readyState = 3;
        if (self._eventSource) self._eventSource.close();
      });
    };

    WsPolyfill.prototype.addEventListener = function (type, listener) {
      if (type === 'open') this.onopen = listener;
      else if (type === 'message') this.onmessage = listener;
      else if (type === 'close') this.onclose = listener;
      else if (type === 'error') this.onerror = listener;
    };

    WsPolyfill.prototype.removeEventListener = function (type, listener) {
      if (type === 'open' && this.onopen === listener) this.onopen = null;
      else if (type === 'message' && this.onmessage === listener) this.onmessage = null;
      else if (type === 'close' && this.onclose === listener) this.onclose = null;
      else if (type === 'error' && this.onerror === listener) this.onerror = null;
    };

    Object.defineProperty(WsPolyfill.prototype, 'readyState', {
      get: function () { return this._readyState; }
    });

    Object.defineProperty(WsPolyfill.prototype, 'url', {
      get: function () { return this._url; }
    });

    Object.defineProperty(WsPolyfill.prototype, 'bufferedAmount', {
      get: function () { return 0; }
    });

    return WsPolyfill;
  }

  installInterceptors();

})(typeof window !== 'undefined' ? window : this);
