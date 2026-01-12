// Port management service frontend app
// 依赖: sw_client.js (需要在 HTML 中先加载)

class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        
        // 端口列表（localStorage 持久化）
        this.ports = new Set();
        this.loadPorts();
        
        // Service Worker 状态
        this.serviceWorkerStates = new Map();
        this.portStrategies = new Map();
        this.swConfiguredPorts = new Set();
        this.deletingPorts = new Set();
        
        // 代理检测结果
        this.proxyDecodeDepth = 0;
        this.slashExtraDecoding = false;

        // URL template
        this.urlTemplate = null;
        this.hasProxySupport = false;
        this.templateRegex = null;

        this.loadPortStrategies();
        this.initServiceWorkerSupport();
        this.initializeApp();

        setInterval(() => this.refreshPorts(), 5000);
    }

    // ==================== 端口持久化 ====================
    
    loadPorts() {
        try {
            const saved = localStorage.getItem('forwarded_ports');
            if (saved) {
                const arr = JSON.parse(saved);
                this.ports = new Set(arr.filter(p => Number.isInteger(p) && p > 0 && p <= 65535));
            }
        } catch { }
    }

    savePorts() {
        try {
            localStorage.setItem('forwarded_ports', JSON.stringify([...this.ports]));
        } catch { }
    }

    addPortToList(port) {
        if (port > 0 && port <= 65535) {
            this.ports.add(port);
            this.savePorts();
        }
    }

    removePortFromList(port) {
        this.ports.delete(port);
        this.savePorts();
    }

    // ==================== 初始化 ====================

    async initializeApp() {
        await this.loadUrlTemplate();
        if (this.hasProxySupport) {
            await this.detectEncoding();
        }
        this.setupPortInput();
        await this.syncServiceWorkers();
        await this.refreshPorts();
    }

    async loadUrlTemplate() {
        try {
            const response = await fetch(`${this.basePath}/api/url-template`);
            const data = await response.json();
            this.urlTemplate = data.template;
            this.hasProxySupport = data.has_proxy_support;
            if (this.urlTemplate) {
                this.templateRegex = SwClient.compileTemplateRegex(this.urlTemplate);
            }
            this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
        } catch (error) {
            console.warn('[Template] Load failed:', error);
            this.urlTemplate = null;
            this.hasProxySupport = false;
            this.swEnabled = false;
        }
    }

    async detectEncoding() {
        // 使用 sw_client.js 的编码检测
        const testEndpoint = `${this.basePath}/api/test-encoding`;
        const result = await SwClient.detectProxyEncoding(testEndpoint);
        this.proxyDecodeDepth = result.decodeDepth;
        this.slashExtraDecoding = result.slashExtraDecoding;
    }

    initServiceWorkerSupport() {
        this.swSupported = 'serviceWorker' in navigator;
        this.isSubpath = this.basePath !== '';
        this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
    }

    setupPortInput() {
        const addPortBtn = document.getElementById('addPortBtn');
        const addPortInput = document.getElementById('addPortInput');
        if (!addPortBtn || !addPortInput) return;

        addPortBtn.addEventListener('click', () => {
            addPortBtn.style.display = 'none';
            addPortInput.style.display = 'block';
            addPortInput.focus();
        });

        addPortInput.addEventListener('blur', () => {
            if (!addPortInput.value) {
                addPortInput.style.display = 'none';
                addPortBtn.style.display = 'flex';
            }
        });

        addPortInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addPort();
        });
    }

    // ==================== URL 模板处理 ====================

    generateProxyUrlForPort(port) {
        return SwClient.generateProxyUrl(this.urlTemplate, port);
    }

    getAbsoluteUrl(url) {
        if (url.startsWith('/')) {
            return window.location.protocol + '//' + window.location.host + url;
        }
        return url;
    }

    // ==================== Service Worker 管理 ====================

    isOurServiceWorker(scriptURL) {
        if (!scriptURL) return false;
        try {
            const expectedScriptPrefix = `${window.location.origin}${this.basePath}/`;
            if (!scriptURL.startsWith(expectedScriptPrefix)) return false;
            const scriptName = scriptURL.substring(expectedScriptPrefix.length);
            return scriptName.startsWith('unified_service_worker.js');
        } catch {
            return false;
        }
    }

    extractPortFromScope(scope) {
        if (!this.templateRegex) return null;
        const normalizedScope = SwClient.normalizeUrl(scope);
        const match = normalizedScope.match(this.templateRegex);
        return (match && match[1]) ? parseInt(match[1]) : null;
    }

    async syncServiceWorkers() {
        if (!('serviceWorker' in navigator) || !this.hasProxySupport) return;

        try {
            // 使用 sw_client.js 获取注册列表
            const registrations = await SwClient.getRegistrations();
            const foundPorts = new Set();

            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL ||
                    registration.waiting?.scriptURL ||
                    registration.installing?.scriptURL || '';

                if (!this.isOurServiceWorker(scriptURL)) continue;

                const port = this.extractPortFromScope(registration.scope);
                if (port && !this.deletingPorts.has(port)) {
                    foundPorts.add(port);
                    
                    // 同步到端口列表
                    this.addPortToList(port);
                    
                    const state = registration.active ? 'active' :
                        registration.waiting ? 'waiting' :
                            registration.installing ? 'installing' : 'unknown';

                    this.serviceWorkerStates.set(port, {
                        registered: true,
                        loading: false,
                        scope: SwClient.normalizeUrl(registration.scope),
                        registration: registration,
                        state: state
                    });
                    
                    // 恢复配置
                    if (registration.active && !this.swConfiguredPorts.has(port)) {
                        const savedStrategy = this.getPortStrategy(port);
                        if (savedStrategy && savedStrategy !== 'none') {
                            this.sendSwConfig(registration.active, savedStrategy);
                            this.swConfiguredPorts.add(port);
                        }
                    }
                }
            }
            
            // 清理已注销的 SW 状态
            for (const port of this.serviceWorkerStates.keys()) {
                if (!foundPorts.has(port)) {
                    this.serviceWorkerStates.delete(port);
                    this.swConfiguredPorts.delete(port);
                }
            }
        } catch (error) {
            console.error('[SW] Sync failed:', error);
        }
    }

    sendSwConfig(worker, strategy) {
        // 使用 sw_client.js 配置 SW
        SwClient.configureServiceWorker(worker, {
            strategy: strategy,
            decodeDepth: this.proxyDecodeDepth,
            slashExtraDecoding: this.slashExtraDecoding
        });
    }

    async registerPortServiceWorker(port) {
        if (!this.swEnabled) return;

        const proxyUrl = this.generateProxyUrlForPort(port);
        if (!proxyUrl) return;

        let scope = proxyUrl;
        if (!scope.endsWith('/')) scope += '/';

        const swScriptPath = `${this.basePath}/unified_service_worker.js`;

        try {
            // 使用 sw_client.js 注册 SW
            const registration = await SwClient.registerServiceWorker(swScriptPath, scope);

            this.serviceWorkerStates.set(port, {
                registered: true,
                loading: false,
                scope: scope,
                registration: registration,
                state: 'active'
            });
        } catch (error) {
            console.error(`[SW Register] Failed for port ${port}:`, error);
            throw error;
        }
    }

    async unregisterServiceWorker(scope) {
        // 使用 sw_client.js 注销 SW
        await SwClient.unregisterServiceWorker(scope);
    }

    // ==================== 策略管理 ====================

    loadPortStrategies() {
        try {
            const saved = localStorage.getItem('port_strategies');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.portStrategies = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k), v]));
            }
        } catch { }
    }

    savePortStrategies() {
        try {
            const obj = Object.fromEntries(this.portStrategies);
            localStorage.setItem('port_strategies', JSON.stringify(obj));
        } catch { }
    }

    getPortStrategy(port) {
        return this.portStrategies.get(port) || 'none';
    }

    updatePortStrategy(port, mode) {
        this.portStrategies.set(port, mode);
        this.savePortStrategies();
    }

    clearPortStrategy(port) {
        this.portStrategies.delete(port);
        this.savePortStrategies();
    }

    /**
     * 获取端口的实际模式（从 SW 查询）
     */
    async getPortMode(port) {
        const swState = this.serviceWorkerStates.get(port);
        if (!swState || !swState.registered || !swState.registration?.active) {
            return 'none';
        }
        
        // 从 SW 查询真实配置
        const config = await SwClient.getServiceWorkerConfig(swState.registration.active);
        if (config && config.strategy) {
            // 同步到本地存储
            if (config.strategy !== 'none') {
                this.portStrategies.set(port, config.strategy);
            }
            return config.strategy;
        }
        
        // 查询失败，回退到本地存储
        return this.getPortStrategy(port);
    }

    /**
     * 同步获取端口模式（用于 UI 渲染，不阻塞）
     */
    getPortModeSync(port) {
        const swState = this.serviceWorkerStates.get(port);
        if (!swState || !swState.registered) return 'none';
        return this.getPortStrategy(port);
    }

    // ==================== 端口操作 ====================

    async addPort() {
        const portInput = document.getElementById('addPortInput');
        const port = parseInt(portInput.value);
        if (!port || port < 1 || port > 65535) return;

        try {
            // 1. 添加到持久化列表
            this.addPortToList(port);
            
            // 2. 注册 SW（如果支持）
            if (this.hasProxySupport) {
                await this.registerPortServiceWorker(port);
            }
            
            // 3. 重置输入
            portInput.value = '';
            portInput.style.display = 'none';
            document.getElementById('addPortBtn').style.display = 'flex';
            
            await this.refreshPorts();
        } catch (error) {
            console.error('[Add Port] Failed:', error);
        }
    }

    async stopForwarding(port) {
        console.log(`[Stop Forwarding] Port ${port}`);
        
        this.deletingPorts.add(port);
        const swState = this.serviceWorkerStates.get(port);
        
        // 清理状态
        this.removePortFromList(port);
        this.clearPortStrategy(port);
        this.serviceWorkerStates.delete(port);
        this.swConfiguredPorts.delete(port);
        
        // 立即刷新 UI
        this.refreshPorts();
        
        // 异步注销 SW
        if (swState && swState.scope) {
            this.unregisterServiceWorker(swState.scope)
                .finally(() => this.deletingPorts.delete(port));
        } else {
            this.deletingPorts.delete(port);
        }
    }

    async switchPortMode(port, newMode) {
        const currentMode = this.getPortMode(port);
        if (currentMode === newMode) return;

        console.log(`[Mode Switch] Port ${port}: ${currentMode} -> ${newMode}`);
        this.setLoadingState(port, true);

        try {
            this.swConfiguredPorts.delete(port);
            
            if (newMode === 'none') {
                this.clearPortStrategy(port);
                const swState = this.serviceWorkerStates.get(port);
                if (swState?.registration?.active) {
                    SwClient.configureServiceWorker(swState.registration.active, {
                        strategy: 'none',
                        decodeDepth: 0,
                        slashExtraDecoding: false
                    });
                }
            } else {
                this.updatePortStrategy(port, newMode);
                
                let swState = this.serviceWorkerStates.get(port);
                if (!swState?.registered) {
                    await this.registerPortServiceWorker(port);
                    swState = this.serviceWorkerStates.get(port);
                }
                
                if (swState?.registration?.active) {
                    this.sendSwConfig(swState.registration.active, newMode);
                }
            }
        } catch (error) {
            console.error(`[Mode Switch] Failed for port ${port}:`, error);
        } finally {
            this.setLoadingState(port, false);
            this.refreshPorts();
        }
    }

    setLoadingState(port, loading) {
        const currentState = this.serviceWorkerStates.get(port) || {};
        this.serviceWorkerStates.set(port, { ...currentState, loading: loading });
    }

    // ==================== 刷新与渲染 ====================

    async refreshPorts() {
        try {
            await this.syncServiceWorkers();
            
            const portList = [...this.ports];
            if (portList.length === 0) {
                this.displayPorts([]);
                return;
            }

            // 批量查询后端
            const response = await fetch(`${this.basePath}/api/ports/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ports: portList })
            });
            
            const portInfos = await response.json();
            this.displayPorts(portInfos);
        } catch (error) {
            console.error('Refresh ports failed:', error);
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        const emptyState = document.getElementById('emptyState');
        const allPorts = this.mergePortData(ports);

        if (allPorts.length === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        // 检查用户是否正在交互
        const activeElement = document.activeElement;
        const isInteracting = activeElement && tbody.contains(activeElement) &&
            ['SELECT', 'BUTTON', 'INPUT'].includes(activeElement.tagName);

        if (isInteracting) return;

        this.updatePortsIncremental(tbody, allPorts);
    }

    mergePortData(ports) {
        const portMap = new Map(ports.map(p => [p.port, p]));
        
        // 确保所有持久化的端口都显示
        for (const port of this.ports) {
            if (!portMap.has(port)) {
                portMap.set(port, {
                    port: port,
                    is_listening: false,
                    process_name: null,
                    process_pid: null,
                    process_cmdline: null,
                    proxy_url: this.generateProxyUrlForPort(port)
                });
            }
        }

        return Array.from(portMap.values())
            .map(p => ({
                ...p,
                has_service_worker: this.serviceWorkerStates.has(p.port),
                sw_state: this.serviceWorkerStates.get(p.port)?.state
            }))
            .sort((a, b) => a.port - b.port);
    }

    updatePortsIncremental(tbody, allPorts) {
        const existingRows = new Map();
        tbody.querySelectorAll('tr[data-port]').forEach(row => {
            existingRows.set(parseInt(row.dataset.port), row);
        });

        const newPortsMap = new Map(allPorts.map(p => [p.port, p]));

        // 删除不存在的
        existingRows.forEach((row, port) => {
            if (!newPortsMap.has(port)) row.remove();
        });

        // 添加或更新
        allPorts.forEach((portData, index) => {
            const existingRow = existingRows.get(portData.port);

            if (!existingRow) {
                const newRow = this.createPortRowElement(portData);
                if (index === 0) {
                    tbody.prepend(newRow);
                } else {
                    const prevPort = allPorts[index - 1];
                    const prevRow = tbody.querySelector(`tr[data-port="${prevPort.port}"]`);
                    prevRow ? prevRow.after(newRow) : tbody.appendChild(newRow);
                }
            } else {
                this.updatePortRowIfNeeded(existingRow, portData);
            }
        });
    }

    createPortRowElement(portData) {
        const tr = document.createElement('tr');
        tr.dataset.port = portData.port;
        tr.innerHTML = this.renderPortRowContent(portData);
        return tr;
    }

    renderPortRowContent(port) {
        const isListening = port.is_listening;
        const processInfo = this.formatProcessInfo(port);
        const proxyUrl = this.hasProxySupport && port.proxy_url ? port.proxy_url : '';
        const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';
        const swModeSelect = this.hasProxySupport ? this.renderProxyModeSelect(port) : '<span class="process-info">N/A</span>';

        return `
            <td class="col-port">
                <div class="port-cell-content">
                    <span>
                        <span class="status-dot ${isListening ? 'active' : ''}"></span>
                        ${port.port}
                    </span>
                    ${this.hasProxySupport ? `<button class="action-btn" title="Stop Forwarding" onclick="app.stopForwarding(${port.port})">×</button>` : ''}
                </div>
            </td>
            <td class="col-address">
                ${proxyUrl ? `<a href="${absoluteUrl}" target="_blank" class="address-link">${proxyUrl}</a>` : ''}
            </td>
            <td class="col-proxy-mode">
                ${swModeSelect}
            </td>
            <td class="col-process">
                <span class="process-info">${this.escapeHtml(processInfo)}</span>
            </td>
        `;
    }

    renderProxyModeSelect(port) {
        if (!this.swEnabled || !port.proxy_url) return '';

        const currentMode = this.getPortModeSync(port.port);
        const swState = this.serviceWorkerStates.get(port.port) || { loading: false };

        if (swState.loading) {
            return '<span class="process-info">Updating...</span>';
        }

        return `
            <select class="proxy-mode-select" onchange="app.switchPortMode(${port.port}, this.value)">
                <option value="none" ${currentMode === 'none' ? 'selected' : ''}>None</option>
                <option value="subpath" ${currentMode === 'subpath' ? 'selected' : ''}>Subpath</option>
                <option value="tunnel" ${currentMode === 'tunnel' ? 'selected' : ''}>Tunnel</option>
                <option value="hybrid" ${currentMode === 'hybrid' ? 'selected' : ''}>Hybrid</option>
            </select>
        `;
    }

    updatePortRowIfNeeded(row, newData) {
        // 更新状态点
        const statusDot = row.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.toggle('active', newData.is_listening);
        }

        // 更新代理 URL
        const addressCell = row.querySelector('.col-address');
        if (addressCell) {
            const proxyUrl = this.hasProxySupport && newData.proxy_url ? newData.proxy_url : '';
            const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';
            const newHtml = proxyUrl ? `<a href="${absoluteUrl}" target="_blank" class="address-link">${proxyUrl}</a>` : '';
            if (addressCell.innerHTML.trim() !== newHtml) {
                addressCell.innerHTML = newHtml;
            }
        }

        // 更新 Proxy Mode（避免打断交互）
        const proxyModeCell = row.querySelector('.col-proxy-mode');
        const proxyModeSelect = proxyModeCell?.querySelector('select');
        if (proxyModeCell && document.activeElement !== proxyModeSelect) {
            const newModeHtml = this.hasProxySupport ? this.renderProxyModeSelect(newData) : '<span class="process-info">N/A</span>';
            if (proxyModeCell.innerHTML.trim() !== newModeHtml.trim()) {
                proxyModeCell.innerHTML = newModeHtml;
            }
        }

        // 更新进程信息
        const processCell = row.querySelector('.col-process .process-info');
        if (processCell) {
            const newProcessInfo = this.formatProcessInfo(newData);
            if (processCell.textContent !== newProcessInfo) {
                processCell.textContent = newProcessInfo;
            }
        }
    }

    formatProcessInfo(port) {
        if (!port.is_listening) return '';
        const pid = port.process_pid || '';
        const cmd = port.process_cmdline || port.process_name || 'Unknown';
        return pid ? `(${pid}) ${cmd}` : cmd;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize
const app = new PortApp();
window.app = app;
