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

    // 6) WebSocket 拦截：SW fetch 事件不触发 WebSocket 连接，唯一能处理的方式
    if (OrigWebSocket) {
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
      global.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
      global.WebSocket.OPEN = OrigWebSocket.OPEN;
      global.WebSocket.CLOSING = OrigWebSocket.CLOSING;
      global.WebSocket.CLOSED = OrigWebSocket.CLOSED;
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

  installInterceptors();

})(typeof window !== 'undefined' ? window : this);
