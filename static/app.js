// 端口管理服务前端应用
class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        this.serviceWorkerStates = new Map(); // 存储每个端口的 Service Worker 状态
        this.portDecodeDepths = new Map(); // 存储每个端口的解码深度设置
        this.portStrategies = new Map(); // 存储每个端口的策略选择 (subpath/tunnel)
        this.addPortTimeout = null; // 防抖定时器
        this.nginxDecodeDepth = 0; // nginx 解码深度
        
        // URL模板相关
        this.urlTemplate = null;
        this.hasProxySupport = false;
        this.templateRegex = null; // 缓存编译的正则
        
        this.loadPortStrategies(); // 加载保存的策略设置
        this.setupPortInput();
        this.initServiceWorkerSupport();
        
        // 先检测Service Worker状态，再刷新端口
        this.initializeApp();
        
        // 定期刷新端口信息
        setInterval(() => {
            this.refreshPorts();
        }, 5000);
    }

    async initializeApp() {
        // 1. 首先加载URL模板
        await this.loadUrlTemplate();
        
        // 2. 如果有代理支持，进行nginx编码检测
        if (this.hasProxySupport) {
            await this.detectNginxEncoding();
        }
        
        // 3. 更新Service Worker状态
        await this.updateServiceWorkerStates();
        
        // 4. 刷新端口列表
        await this.refreshPorts();
    }

    async loadUrlTemplate() {
        try {
            const response = await fetch(`${this.basePath}/api/url-template`);
            const data = await response.json();
            
            this.urlTemplate = data.template;
            this.hasProxySupport = data.has_proxy_support;
            
            // 预编译正则表达式
            if (this.urlTemplate) {
                this.templateRegex = this.compileTemplateRegex(this.urlTemplate);
                console.log(`[模板] 加载成功: ${this.urlTemplate}`);
            } else {
                console.log('[模板] 当前环境不支持代理');
            }
            
            // 重新设置Service Worker启用状态
            this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
            console.log(`[SW] Service Worker启用状态: ${this.swEnabled} (支持: ${this.swSupported}, 子路径: ${this.isSubpath}, 代理: ${this.hasProxySupport})`);
            
        } catch (error) {
            console.warn('[模板] 加载失败:', error);
            this.urlTemplate = null;
            this.hasProxySupport = false;
            this.swEnabled = false;
        }
    }

    compileTemplateRegex(template) {
        // 转义正则特殊字符
        const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 将{{port}}替换为数字捕获组
        const pattern = escaped.replace('\\{\\{port\\}\\}', '(\\d+)');
        return new RegExp(pattern);
    }

    normalizeUrl(url) {
        // 统一URL格式处理
        try {
            if (url.startsWith('http')) {
                return new URL(url).pathname;
            }
            return url.startsWith('/') ? url : '/' + url;
        } catch {
            return url;
        }
    }

    async detectNginxEncoding() {
        try {
            const testSegment = "test/path";  // 原始测试路径段
            let maxLayers = 4;  // 初始最大检测层数
            const maxAttempts = 8;  // 最大尝试层数上限
            
            // 基准状态：编码一次后的状态（浏览器发送URL的标准状态）
            const baseEncoded = encodeURIComponent(testSegment);  // "test%2Fpath"
            
            while (maxLayers <= maxAttempts) {
                // 在基准状态基础上进行额外编码
                let encodedSegment = baseEncoded;
                for (let i = 0; i < maxLayers; i++) {
                    encodedSegment = encodeURIComponent(encodedSegment);
                }
                
                // 发送检测请求
                const response = await fetch(`${this.basePath}/api/test-encoding/${encodedSegment}`);
                
                if (!response.ok) {
                    this.nginxDecodeDepth = 0;
                    break;
                }
                
                const result = await response.json();
                
                // 计算nginx解码深度：将result.path重新编码，看需要编码多少次能回到原始发送的encodedSegment
                let current = result.path;
                let encodeSteps = 0;
                
                // 逐步编码，直到匹配原始发送的encodedSegment或达到最大层数
                while (current !== encodedSegment && encodeSteps < maxLayers) {
                    current = encodeURIComponent(current);
                    encodeSteps++;
                }
                
                // 如果能编码回到原始发送的encodedSegment，那么nginx解码深度就是encodeSteps
                const detectedDepth = (current === encodedSegment) ? encodeSteps : 0;
                
                // 验证检测结果
                const verified = await this.verifyNginxDecodeDepth(baseEncoded, detectedDepth);
                if (verified) {
                    this.nginxDecodeDepth = detectedDepth;
                    console.log(`[编码检测] NGINX_DECODE_DEPTH: ${this.nginxDecodeDepth} (验证通过)`);
                    return;
                } else {
                    console.warn(`[编码验证] 层数${maxLayers}检测失败，增加检测层数重试`);
                }
                
                // 增加检测层数重试
                maxLayers++;
            }
            
            // 所有尝试都失败，设置为0
            this.nginxDecodeDepth = 0;
            console.warn(`[编码检测] 达到最大尝试次数${maxAttempts}，放弃检测，设置为0`);
            
        } catch (error) {
            console.error('[编码检测] 发生异常:', error);
            this.nginxDecodeDepth = 0;
        }
    }

    async verifyNginxDecodeDepth(baseEncoded, detectedDepth) {
        try {
            // 用检测到的解码深度进行反向验证
            let verifySegment = baseEncoded;
            for (let i = 0; i < detectedDepth; i++) {
                verifySegment = encodeURIComponent(verifySegment);
            }
            
            // 发送验证请求
            const verifyResponse = await fetch(`${this.basePath}/api/test-encoding/${verifySegment}`);
            if (verifyResponse.ok) {
                const verifyResult = await verifyResponse.json();
                // 验证nginx是否确实解码到了基准状态
                return verifyResult.path === baseEncoded;
            }
            return false;
        } catch (error) {
            console.error('[编码验证] 验证过程异常:', error);
            return false;
        }
    }


    setupPortInput() {
        const portInput = document.getElementById('portInput');
        
        // 监听输入事件，实现防抖自动添加
        portInput.addEventListener('input', (e) => {
            const port = e.target.value.trim();
            
            // 清除之前的定时器
            if (this.addPortTimeout) {
                clearTimeout(this.addPortTimeout);
            }
            
            // 如果输入为空，不处理
            if (!port) return;
            
            // 验证端口号格式
            const portNum = parseInt(port);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                return;
            }
            
            // 设置防抖定时器，1秒后自动添加
            this.addPortTimeout = setTimeout(() => {
                this.addPortAuto(portNum);
            }, 1000);
        });
        
        // 保留回车键直接添加的功能
        portInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                // 清除防抖定时器
                if (this.addPortTimeout) {
                    clearTimeout(this.addPortTimeout);
                }
                this.addPort();
            }
        });
    }

    initServiceWorkerSupport() {
        // 检查浏览器是否支持 Service Worker
        this.swSupported = 'serviceWorker' in navigator;
        this.isSubpath = this.basePath !== '';
        
        // 只有在有代理支持时才启用Service Worker功能
        this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
    }

    async cleanupExistingServiceWorkers() {
        if (!('serviceWorker' in navigator)) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            let cleanedCount = 0;
            
            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL || 
                                 registration.waiting?.scriptURL ||
                                 registration.installing?.scriptURL || '';
                
                // 通过脚本名称识别我们的Service Worker
                if (scriptURL.includes('subpath_service_worker.js') || 
                    scriptURL.includes('tunnel_service_worker.js')) {
                    
                    await registration.unregister();
                    cleanedCount++;
                    console.log(`[SW清理] 已清理: ${scriptURL}`);
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`[SW清理] 共清理 ${cleanedCount} 个Service Worker`);
                this.displayServiceWorkerInfo();
            }
        } catch (error) {
            console.error('[SW清理] 清理失败:', error);
        }
    }

    async updateServiceWorkerStates() {
        if (!('serviceWorker' in navigator) || !this.hasProxySupport) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            
            // 清空现有状态
            this.serviceWorkerStates.clear();
            
            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL || 
                                 registration.waiting?.scriptURL ||
                                 registration.installing?.scriptURL || '';
                
                // 只处理我们的Service Worker
                if (!scriptURL.includes('subpath_service_worker.js') && 
                    !scriptURL.includes('tunnel_service_worker.js')) {
                    continue;
                }
                
                // 从scope中提取端口号
                const port = this.extractPortFromScope(registration.scope);
                if (port) {
                    const state = registration.active ? 'active' : 
                                 registration.waiting ? 'waiting' : 
                                 registration.installing ? 'installing' : 'unknown';
                    
                    this.serviceWorkerStates.set(port, {
                        registered: true,
                        loading: false,
                        scope: this.normalizeUrl(registration.scope),
                        registration: registration,
                        state: state
                    });
                    
                    console.log(`[SW状态] 端口 ${port}: ${state}`);
                }
            }
            
        } catch (error) {
            console.error('[SW状态] 更新失败:', error);
        }
    }

    extractPortFromScope(scope) {
        if (!this.templateRegex) {
            console.warn('[端口提取] 无模板正则，无法解析scope');
            return null;
        }
        
        // 规范化scope路径
        const normalizedScope = this.normalizeUrl(scope);
        
        // 使用预编译的正则匹配
        const match = normalizedScope.match(this.templateRegex);
        if (match && match[1]) {
            const port = parseInt(match[1]);
            console.log(`[端口提取] scope: ${normalizedScope} -> 端口: ${port}`);
            return port;
        }
        
        console.warn(`[端口提取] 无法从scope提取端口: ${normalizedScope}`);
        return null;
    }

    generateProxyUrlForPort(port) {
        if (!this.urlTemplate) {
            console.warn(`[URL生成] 无模板，端口 ${port} 无法生成代理URL`);
            return null;
        }
        
        const proxyUrl = this.urlTemplate.replace('{{port}}', port.toString());
        console.log(`[URL生成] 端口 ${port} -> ${proxyUrl}`);
        return proxyUrl;
    }



    async unregisterSubpathServiceWorker(scope) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            const targetRegistration = registrations.find(reg => reg.scope === scope);
            
            if (targetRegistration) {
                const port = this.extractPortFromScope(scope);
                await targetRegistration.unregister();
                
                // 更新状态
                if (port) {
                    this.serviceWorkerStates.delete(port);
                }
                
                // 刷新显示
                this.refreshPorts();
            } else {
                console.warn('未找到对应的 Service Worker');
            }
        } catch (error) {
            // 注销失败
        }
    }

    async addPort() {
        const portInput = document.getElementById('portInput');
        const port = portInput.value;
        
        if (!port || port < 1 || port > 65535) {
            console.warn('请输入有效的端口号');
            return;
        }

        try {
            await fetch(`${this.basePath}/api/port/${port}`);
            portInput.value = '';
            this.refreshPorts();
        } catch (error) {
            // 添加端口失败
        }
    }

    async addPortAuto(port) {
        // 自动添加端口，不显示警告信息
        try {
            await fetch(`${this.basePath}/api/port/${port}`);
            // 清空输入框
            document.getElementById('portInput').value = '';
            this.refreshPorts();
        } catch (error) {
            // 自动添加失败，静默处理
        }
    }

    async refreshPorts() {
        try {
            const response = await fetch(`${this.basePath}/api/ports`);
            const ports = await response.json();
            
            // 同时更新Service Worker状态
            await this.updateServiceWorkerStates();
            
            this.displayPorts(ports);
        } catch (error) {
            document.getElementById('portTableBody').innerHTML = '<tr><td colspan="8" class="error">获取端口列表失败</td></tr>';
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        
        // 根据代理支持情况调整表头显示
        this.updateTableHeaders();
        
        // 合并端口数据
        const allPorts = this.mergePortData(ports);
        
        if (allPorts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="no-ports">暂无端口数据</td></tr>';
            return;
        }

        tbody.innerHTML = allPorts.map(port => this.renderPortRow(port)).join('');
    }

    updateTableHeaders() {
        // 根据hasProxySupport动态显示/隐藏相关列
        const proxyColumns = document.querySelectorAll('.proxy-column');
        proxyColumns.forEach(col => {
            col.style.display = this.hasProxySupport ? '' : 'none';
        });
    }

    mergePortData(ports) {
        const allPorts = new Map();
        
        // 添加后端返回的端口
        ports.forEach(port => {
            allPorts.set(port.port, {
                ...port,
                source: 'backend'
            });
        });
        
        // 添加已注册Service Worker的端口（如果不在后端列表中）
        this.serviceWorkerStates.forEach((swState, port) => {
            if (!allPorts.has(port)) {
                // 仅Service Worker的端口，生成代理URL
                const proxyUrl = this.generateProxyUrlForPort(port);
                allPorts.set(port, {
                    port: port,
                    is_listening: false,
                    process_name: null,
                    proxy_url: proxyUrl,
                    source: 'service_worker',
                    sw_state: swState.state
                });
            } else {
                // 如果端口在后端列表中，标记它有Service Worker
                const existingPort = allPorts.get(port);
                existingPort.has_service_worker = true;
                existingPort.sw_state = swState.state;
            }
        });
        
        return Array.from(allPorts.values()).sort((a, b) => a.port - b.port);
    }

    renderPortRow(port) {
        // 监听状态图标
        let listenIcon;
        if (port.source === 'service_worker') {
            listenIcon = '<span class="status-icon closed" title="未监听">●</span>';
        } else if (port.is_listening) {
            listenIcon = '<span class="status-icon listening" title="监听中">●</span>';
        } else {
            listenIcon = '<span class="status-icon closed" title="未监听">●</span>';
        }
        
        // 进程信息
        const processInfo = this.formatProcessInfo(port);
        
        // URL链接 - 只有在有代理支持时才显示
        const urlCell = this.hasProxySupport && port.proxy_url ? 
            `<a href="${this.getAbsoluteUrl(port.proxy_url)}" target="_blank" class="url-link">${port.proxy_url}</a>` : 
            '<span class="no-proxy">无代理支持</span>';
        
        // Service Worker相关控件 - 只有在有代理支持时才显示
        const swControls = this.hasProxySupport ? this.renderServiceWorkerControls(port) : 
            '<span class="no-proxy">N/A</span>';
        
        return `
            <tr class="${port.source === 'service_worker' ? 'sw-only-row' : ''}">
                <td class="status-cell">${listenIcon}</td>
                <td class="port-cell">${port.port}</td>
                <td class="url-cell proxy-column">${urlCell}</td>
                <td class="process-cell">${processInfo}</td>
                <td class="decode-depth-cell proxy-column">${swControls.decodeDepth}</td>
                <td class="sw-cell proxy-column">${swControls.swIcon}</td>
                <td class="strategy-cell proxy-column">${swControls.strategy}</td>
            </tr>
        `;
    }

    renderServiceWorkerControls(port) {
        // 解码深度输入框
        if (!this.portDecodeDepths.has(port.port)) {
            this.portDecodeDepths.set(port.port, this.nginxDecodeDepth);
        }
        const currentDecodeDepth = this.portDecodeDepths.get(port.port);
        const decodeDepthInput = this.swEnabled && port.proxy_url ? 
            `<input type="number" class="decode-depth-input" value="${currentDecodeDepth}" min="0" max="10" 
             onchange="app.updatePortDecodeDepth(${port.port}, this.value)" 
             title="nginx解码深度 (默认: ${this.nginxDecodeDepth})">` :
            '<span class="decode-depth-disabled">N/A</span>';
        
        // Service Worker 补丁图标
        const swState = this.serviceWorkerStates.get(port.port) || { registered: false, loading: false };
        const swIcon = this.swEnabled && port.proxy_url ? 
            this.generateSwIcon(port.port, swState) : 
            '<span class="sw-icon disabled" title="不支持">⚫</span>';
        
        // 策略选择下拉框
        const currentStrategy = this.getPortStrategy(port.port);
        const strategySelect = this.swEnabled && port.proxy_url ? 
            `<select class="strategy-select" onchange="app.switchPortStrategy(${port.port}, this.value)">
                <option value="subpath" ${currentStrategy === 'subpath' ? 'selected' : ''}>子路径修复</option>
                <option value="tunnel" ${currentStrategy === 'tunnel' ? 'selected' : ''}>HTTP隧道</option>
            </select>` :
            '<span class="strategy-disabled">N/A</span>';
        
        return {
            decodeDepth: decodeDepthInput,
            swIcon: swIcon,
            strategy: strategySelect
        };
    }

    generateSwIcon(port, swState) {
        if (swState.loading) {
            return '<span class="sw-icon loading" title="处理中...">🔄</span>';
        }
        
        const currentStrategy = this.getPortStrategy(port);
        const isRegistered = swState.registered;
        const action = isRegistered ? 'unregisterPortServiceWorker' : 'registerPortServiceWorker';
        
        // 根据策略显示不同的Service Worker类型
        const strategyName = currentStrategy === 'tunnel' ? 'tunnel_service_worker.js' : 'subpath_service_worker.js';
        const strategyTitle = currentStrategy === 'tunnel' ? 'HTTP隧道' : '子路径修复';
        
        if (isRegistered) {
            // 注册成功 - 绿色补丁图标
            const stateInfo = swState.state ? ` (${swState.state})` : '';
            return `<span class="sw-icon registered" onclick="app.${action}(${port})" title="已注册 ${strategyName}${stateInfo} (${strategyTitle})，点击注销">🟢</span>`;
        } else if (swState.failed) {
            // 注册失败 - 红色补丁图标
            return `<span class="sw-icon failed" onclick="app.${action}(${port})" title="注册失败，点击重试 (${strategyTitle})">🔴</span>`;
        } else {
            // 未注册 - 黄色补丁图标
            return `<span class="sw-icon unregistered" onclick="app.${action}(${port})" title="未注册 ${strategyName} (${strategyTitle})，点击注册">🟡</span>`;
        }
    }

    formatProcessInfo(port) {
        // 当端口未被监听时，显示为空
        if (!port.is_listening || port.source === 'service_worker') {
            return '';
        }
        
        // 当端口被监听时，显示完整的PID和命令行信息
        if (port.process_pid && port.process_cmdline) {
            const pid = port.process_pid;
            const fullCmdline = port.process_cmdline;
            
            // 截断过长的命令行，保持合理的显示长度
            const maxLength = 60;
            let displayCmdline = fullCmdline;
            if (fullCmdline.length > maxLength) {
                displayCmdline = fullCmdline.substring(0, maxLength) + '...';
            }
            
            // 如果命令行被截断，添加title属性显示完整内容
            const titleAttr = fullCmdline.length > maxLength ? ` title="${this.escapeHtml(fullCmdline)}"` : '';
            
            return `<span class="process-info"${titleAttr}>(${pid}) ${this.escapeHtml(displayCmdline)}</span>`;
        }
        
        // 如果只有进程名，显示进程名
        if (port.process_name) {
            return `<span class="process-info">${this.escapeHtml(port.process_name)}</span>`;
        }
        
        // 其他情况显示为空
        return '';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getAbsoluteUrl(url) {
        // 如果URL以/开头，说明是绝对路径，需要加上协议和域名
        if (url.startsWith('/')) {
            return window.location.protocol + '//' + window.location.host + url;
        }
        // 否则返回原URL
        return url;
    }



    async checkServiceWorkerStatus(port, proxyUrl) {
        if (!this.swSupported) return;
        
        try {
            const url = new URL(proxyUrl, window.location.origin);
            let scope = url.pathname;
            
            // 确保作用域以 / 结尾
            if (!scope.endsWith('/')) {
                scope += '/';
            }
            
            const registrations = await navigator.serviceWorker.getRegistrations();
            const matchedRegistration = registrations.find(reg => {
                // 精确匹配作用域
                const regScope = new URL(reg.scope).pathname;
                return regScope === scope;
            });
            
            this.serviceWorkerStates.set(port, { 
                registered: !!matchedRegistration, 
                loading: false,
                scope: scope,
                registration: matchedRegistration
            });
        } catch (error) {
            // 检查Service Worker状态失败
        }
    }

    async registerPortServiceWorker(port) {
        if (!this.swEnabled) {
            console.log(`[SW] 端口 ${port}: Service Worker功能未启用`);
            return;
        }

        // 设置加载状态
        this.serviceWorkerStates.set(port, { 
            ...this.serviceWorkerStates.get(port), 
            loading: true 
        });
        this.refreshPortDisplay();

        try {
            // 使用模板生成代理URL
            const proxyUrl = this.generateProxyUrlForPort(port);
            if (!proxyUrl) {
                throw new Error('无法生成代理URL');
            }

            // 确定Service Worker作用域
            let scope = proxyUrl;
            if (!scope.endsWith('/')) {
                scope += '/';
            }
            
            // 根据策略选择Service Worker脚本
            const currentStrategy = this.getPortStrategy(port);
            let swScriptPath;
            
            if (currentStrategy === 'tunnel') {
                swScriptPath = `${this.basePath}/tunnel_service_worker.js`;
            } else {
                const portDecodeDepth = this.portDecodeDepths.get(port) ?? this.nginxDecodeDepth;
                swScriptPath = `${this.basePath}/subpath_service_worker.js?decode_depth=${portDecodeDepth}`;
            }
            
            console.log(`[SW注册] 端口 ${port}: ${currentStrategy} 策略, scope: ${scope}`);
            
            // 注册Service Worker
            const registration = await navigator.serviceWorker.register(swScriptPath, { scope });

            // 等待激活
            if (registration.installing) {
                await this.waitForServiceWorkerActivation(registration.installing);
            }

            // 更新状态
            this.serviceWorkerStates.set(port, { 
                registered: true, 
                loading: false,
                scope: scope,
                registration: registration,
                state: 'active'
            });
            
            console.log(`[SW注册] 端口 ${port} 注册成功`);
            
        } catch (error) {
            console.error(`[SW注册] 端口 ${port} 注册失败:`, error);
            this.serviceWorkerStates.set(port, { 
                registered: false, 
                loading: false,
                failed: true
            });
        }
        
        this.refreshPortDisplay();
    }

    async waitForServiceWorkerActivation(installingWorker) {
        return Promise.race([
            new Promise((resolve) => {
                installingWorker.addEventListener('statechange', () => {
                    if (installingWorker.state === 'activated' || installingWorker.state === 'redundant') {
                        resolve();
                    }
                });
            }),
            new Promise((resolve) => setTimeout(resolve, 5000)) // 5秒超时
        ]);
    }



    async refreshPortDisplay() {
        // 重新渲染端口列表（不重新获取数据）
        try {
            const response = await fetch(`${this.basePath}/api/ports`);
            const ports = await response.json();
            this.displayPorts(ports);
        } catch (error) {
            // 刷新端口显示失败
        }
    }

    updatePortDecodeDepth(port, value) {
        // 更新端口的解码深度设置
        const decodeDepth = parseInt(value);
        if (isNaN(decodeDepth) || decodeDepth < 0) {
            // 如果输入无效，恢复为该端口当前设置的值
            const input = document.querySelector(`input[onchange*="${port}"]`);
            if (input) {
                input.value = this.portDecodeDepths.get(port);
            }
            return;
        }
        
        // 保存设置
        this.portDecodeDepths.set(port, decodeDepth);
        
        // 如果该端口已注册Service Worker，提示需要重新注册
        const swState = this.serviceWorkerStates.get(port);
        if (swState && swState.registered) {
            console.log(`[解码深度] 端口 ${port} 解码深度已更新为 ${decodeDepth}，需要重新注册Service Worker生效`);
        }
    }

    // ==================== 策略管理方法 ====================
    

    
    async unregisterPortServiceWorker(port) {
        if (!this.swEnabled) {
            console.log(`[SW] 端口 ${port}: Service Worker功能未启用`);
            return;
        }

        const registrations = await navigator.serviceWorker.getRegistrations();
        const proxyUrl = this.generateProxyUrlForPort(port);
        
        if (!proxyUrl) return;
        
        let targetScope = proxyUrl;
        if (!targetScope.endsWith('/')) {
            targetScope += '/';
        }
        
        let targetRegistration = null;
        for (const registration of registrations) {
            const regScope = this.normalizeUrl(registration.scope);
            if (regScope === targetScope) {
                targetRegistration = registration;
                break;
            }
        }
        
        if (targetRegistration) {
            try {
                console.log(`[SW注销] 端口 ${port} 尝试直接注销`);
                await targetRegistration.unregister();
                if (targetRegistration.active) {
                    console.log(`[SW注销] 端口 ${port} 发送强制刷新消息`);
                    targetRegistration.active.postMessage({
                        type: 'FORCE_NAVIGATE_ALL_CLIENTS'
                    });
                }
            } catch (error) {
                console.warn(`[SW注销] 端口 ${port} 注销异常:`, error);
            }
        }
        
        // 清理状态
        this.serviceWorkerStates.delete(port);
        this.refreshPortDisplay();
    }
    
    async switchPortStrategy(port, newStrategy) {
        const oldStrategy = this.getPortStrategy(port);
        
        if (oldStrategy === newStrategy) {
            return; // 策略没有变化，无需处理
        }
        
        console.log(`[策略切换] 端口 ${port}: ${oldStrategy} -> ${newStrategy}`);
        
        // 如果当前端口已注册Service Worker，先注销
        const swState = this.serviceWorkerStates.get(port);
        if (swState && swState.registered) {
            console.log(`[策略切换] 先注销端口 ${port} 的现有Service Worker`);
            await this.unregisterPortServiceWorker(port);
        }
        
        // 更新策略设置
        this.portStrategies.set(port, newStrategy);
        this.savePortStrategies();
        
        // 刷新界面显示
        this.refreshPortDisplay();
        
        console.log(`[策略切换] 端口 ${port} 策略已更新为: ${newStrategy}`);
    }

    getPortStrategy(port) {
        return this.portStrategies.get(port) || 'subpath'; // 默认策略
    }
    
    savePortStrategies() {
        try {
            const strategies = Object.fromEntries(this.portStrategies);
            localStorage.setItem('port-strategies', JSON.stringify(strategies));
        } catch (error) {
            console.warn('[策略保存] 保存失败:', error);
        }
    }
    
    loadPortStrategies() {
        try {
            const saved = localStorage.getItem('port-strategies');
            if (saved) {
                const strategies = JSON.parse(saved);
                this.portStrategies = new Map(Object.entries(strategies));
            }
        } catch (error) {
            console.warn('[策略加载] 加载失败:', error);
            this.portStrategies = new Map();
        }
    }

}

// 全局函数已移除，现在使用自动添加功能

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PortApp();
});