/**
 * Proxy URL 模板解析和环境检测
 */

/**
 * 获取 Proxy URL 模板
 * @returns 模板字符串或 null（环境不支持）
 */
export function getProxyUrlTemplate(): string | null {
  const template = process.env.VSCODE_PROXY_URI;
  return template || null;
}

/**
 * 检测模板是否包含子路径
 * @param template URL 模板
 * @returns 是否包含子路径
 */
export function hasSubpath(template: string): boolean {
  if (!template) return false;

  let path: string;
  if (template.startsWith('http://') || template.startsWith('https://')) {
    try {
      const url = new URL(template.replace('{{port}}', '8080'));
      path = url.pathname;
    } catch {
      return false;
    }
  } else {
    path = template;
  }

  // 规范化路径：移除端口占位符，合并多个斜杠
  const normalized = path.replace('{{port}}', '').replace(/\/+/g, '/');

  // 根路径（/ 或空）不需要 SW
  return normalized !== '/' && normalized !== '';
}

/**
 * 判断是否应该启用扩展
 * @returns 是否启用
 */
export function shouldEnable(): boolean {
  const template = getProxyUrlTemplate();

  // 1. 环境变量不存在 → 不启用
  if (!template) {
    return false;
  }

  // 2. 检测是否包含子路径
  return hasSubpath(template);
}

/**
 * 生成端口代理 URL
 * @param template URL 模板
 * @param port 端口号
 * @returns 代理 URL
 */
export function generateProxyUrl(template: string, port: number): string {
  return template.replace('{{port}}', port.toString());
}
