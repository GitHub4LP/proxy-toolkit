/**
 * 导航拦截器（纯函数闭包版）- 子路径环境下的导航修复
 * 由 Service Worker 注入到 HTML：先设置 window._NavigationInterceptorConfig = { scopeBase: '...' }，后加载本脚本
 * 行为：加载即执行，读取 scopeBase，安装 click/history/window.open/form 四类拦截器
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

  var scopeBase = normalizeScopeBase(cfg.scopeBase);

  // 捕获原方法引用（无需卸载）
  var originalPushState = history.pushState.bind(history);
  var originalReplaceState = history.replaceState.bind(history);
  var originalOpen = global.open.bind(global);

  // 规范化 scopeBase：确保以 "/" 开头、以 "/" 结尾
  function normalizeScopeBase(s) {
    if (!s.startsWith('/')) s = '/' + s;
    if (!s.endsWith('/')) s = s + '/';
    return s;
  }

  // 是否需要对子路径进行修复：仅处理以 "/" 开头的同源根路径
  function needsPathFix(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('http://') || url.startsWith('https://')) return false;
    if (url.startsWith('//')) return false;
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) return false;
    if (url.startsWith('#') || url.startsWith('?')) return false;
    if (url.startsWith('data:') || url.startsWith('blob:')) return false;
    if (url.startsWith(scopeBase)) return false;
    return url.startsWith('/');
  }

  // 修复路径：将以 "/" 开头的同源根路径前缀到 scopeBase
  function fixPath(url) {
    if (!needsPathFix(url)) return url;
    var relativePath = url.substring(1);
    return scopeBase + relativePath;
  }

  // 安装四类拦截器
  function installInterceptors() {
    // 1) 链接点击拦截
    document.addEventListener('click', function (event) {
      try {
        var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!link) return;

        var href = link.getAttribute('href');
        if (!needsPathFix(href)) return;

        event.preventDefault();
        event.stopPropagation();

        var fixedHref = fixPath(href);
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
        var finalUrl = (url !== undefined && url !== null) ? fixPath(url) : url;
        reportChange('pushState', url, finalUrl);
        return originalPushState(state, title, finalUrl);
      } catch (_) {
        return originalPushState(state, title, url);
      }
    };

    history.replaceState = function (state, title, url) {
      try {
        var finalUrl = (url !== undefined && url !== null) ? fixPath(url) : url;
        reportChange('replaceState', url, finalUrl);
        return originalReplaceState(state, title, finalUrl);
      } catch (_) {
        return originalReplaceState(state, title, url);
      }
    };

    // 3) popstate 补救：当路径不完整时，替换为修复后的路径
    global.addEventListener('popstate', function (event) {
      try {
        var currentPath = global.location.pathname;
        if (!needsPathFix(currentPath)) return;
        var fixedPath = fixPath(currentPath) + global.location.search + global.location.hash;
        reportChange('popstate', currentPath + global.location.search + global.location.hash, fixedPath);
        originalReplaceState(event.state, '', fixedPath);
      } catch (_) { /* 静默处理 */ }
    });

    // 4) 表单提交拦截：修复 action 为作用域内路径
    document.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        if (!form || form.tagName !== 'FORM') return;
        var action = form.getAttribute('action');
        if (!action || !needsPathFix(action)) return;
        var fixedAction = fixPath(action);
        reportChange('form', action, fixedAction, { method: form.method || 'GET' });
        form.setAttribute('action', fixedAction);
      } catch (_) { /* 静默处理 */ }
    }, true);
  }

  // 加载即执行
  installInterceptors();

})(typeof window !== 'undefined' ? window : this);