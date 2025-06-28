document.addEventListener('DOMContentLoaded', function() {
    const scanForm = document.getElementById('scanForm');
    const scanButton = document.getElementById('scanButton');
    const clearButton = document.getElementById('clearButton');
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const error = document.getElementById('error');
    const resultsContent = document.getElementById('resultsContent');
    const errorMessage = document.getElementById('errorMessage');
    const scanWarning = document.getElementById('scanWarning');
    const portsInput = document.getElementById('ports');
    const scanAllPortsCheckbox = document.getElementById('scanAllPorts');
    const target = document.getElementById('target');
    const optionCheckboxes = document.querySelectorAll('input[name="options"]');
    const tasksGrid = document.getElementById('tasksGrid');
    const threadsInUse = document.getElementById('threadsInUse');
    const parallelTasksSlider = document.getElementById('parallelTasksSlider');
    const parallelTasks = document.getElementById('parallelTasks');
    const threadModes = document.querySelectorAll('.thread-mode');
    
    const DEFAULT_THREADS = 8;
    const MIN_THREADS = 4;
    const MAX_THREADS = 16;
    
    const TASK_STATUS = {
        'pending': '等待中',
        'task_running': '扫描中',
        'task_progress': '扫描中',
        'task_completed': '已完成',
        'task_error': '出错'
    };
    
    let socket;
    let currentScanId = null;
    let reconnectAttempts = 0;
    let isConnected = false;
    const maxReconnectAttempts = 5;
    
    let activeTasks = {};
    let totalTasks = 0;
    let completedTasks = 0;
    
    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    progressContainer.innerHTML = `
        <div class="progress-bar">
            <div class="progress-fill" id="progressFill"></div>
        </div>
        <div class="progress-text">
            <div>扫描进度: <span id="progressText">0%</span></div>
            <div class="completed-tasks"><span id="completedTasksCount">0</span>/<span id="totalTasksCount">0</span> 任务</div>
        </div>
    `;
    loading.insertBefore(progressContainer, document.querySelector('#tasksOverview'));
    
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const completedTasksCount = document.getElementById('completedTasksCount');
    const totalTasksCount = document.getElementById('totalTasksCount');
    
    const liveOutputContainer = document.createElement('div');
    liveOutputContainer.className = 'live-output';
    liveOutputContainer.innerHTML = `
        <h4>实时扫描输出</h4>
        <pre id="liveOutput" class="live-output-content"></pre>
    `;
    loading.appendChild(liveOutputContainer);
    
    const liveOutput = document.getElementById('liveOutput');
    
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.id = 'cancelScanButton';
    cancelButton.className = 'btn cancel-btn';
    cancelButton.innerHTML = '<i class="fas fa-stop-circle"></i> 取消扫描';
    cancelButton.style.display = 'none';
    loading.appendChild(cancelButton);
    
    const formElements = document.querySelectorAll('.form-group, .form-actions');
    formElements.forEach((element, index) => {
        element.style.opacity = '0';
        element.style.transform = 'translateY(20px)';
        element.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        
        setTimeout(() => {
            element.style.opacity = '1';
            element.style.transform = 'translateY(0)';
        }, 100 + index * 100);
    });
    
    function initThreadControl() {
        parallelTasksSlider.addEventListener('input', function() {
            parallelTasks.value = this.value;
            updateThreadModeSelection(this.value);
            threadsInUse.textContent = this.value;
        });
        
        parallelTasks.addEventListener('input', function() {
            let value = parseInt(this.value);
            if (isNaN(value) || value < MIN_THREADS) value = MIN_THREADS;
            if (value > MAX_THREADS) value = MAX_THREADS;
            
            this.value = value;
            parallelTasksSlider.value = value;
            updateThreadModeSelection(value);
            threadsInUse.textContent = value;
        });
        
        threadModes.forEach(mode => {
            mode.addEventListener('click', function() {
                const value = parseInt(this.dataset.value);
                parallelTasksSlider.value = value;
                parallelTasks.value = value;
                updateThreadModeSelection(value);
                threadsInUse.textContent = value;
            });
        });
        
        updateThreadModeSelection(DEFAULT_THREADS);
    }
    
    function updateThreadModeSelection(value) {
        threadModes.forEach(mode => {
            if (parseInt(mode.dataset.value) === parseInt(value)) {
                mode.classList.add('active');
            } else {
                mode.classList.remove('active');
            }
        });
    }
    
    function initWebSocket() {
        if (socket && socket.connected) {
            return;
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        console.log(`使用WebSocket协议: ${protocol}`);
        
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}`;
        console.log(`WebSocket连接URL: ${wsUrl}`);
        
        socket = io(wsUrl, {
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: maxReconnectAttempts,
            transports: ['websocket'],
            upgrade: false
        });
        
        socket.on('connect', function() {
            console.log('WebSocket连接已建立');
            isConnected = true;
            reconnectAttempts = 0;
            
            updateSocketStatus(true, protocol === 'wss:');
            
            if (currentScanId) {
                joinScanRoom(currentScanId);
            }
        });
        
        socket.on('connection_response', function(data) {
            console.log('连接状态:', data.status);
            console.log('传输方式:', data.transport);
            console.log('会话ID:', data.sid);
            
            const isWebSocket = data.transport === 'websocket';
            const isSecure = window.location.protocol === 'https:';
            
            updateSocketStatus(true, isWebSocket && isSecure);
            
            showInfo(`已连接到服务器`);
        });
        
        socket.on('scan_started', function(data) {
            console.log('扫描已开始，ID:', data.scan_id, '线程数:', data.parallel_tasks);
            currentScanId = data.scan_id;
            threadsInUse.textContent = data.parallel_tasks;
            
            sessionStorage.setItem('currentScanId', currentScanId);
        });
        
        socket.on('scan_update', function(data) {
            console.log('扫描更新:', data.status, data);
            
            switch(data.status) {
                case 'starting':
                    updateProgress(5);
                    updateLiveOutput(`正在使用 ${data.threads} 个线程开始扫描...\n`);
                    break;
                    
                case 'tasks_created':
                    activeTasks = {};
                    totalTasks = data.tasks.length;
                    completedTasks = 0;
                    
                    totalTasksCount.textContent = totalTasks;
                    completedTasksCount.textContent = completedTasks;
                    
                    createTaskCards(data.tasks);
                    updateLiveOutput(`已创建 ${totalTasks} 个扫描子任务\n`);
                    break;
                    
                case 'task_running':
                    updateTaskStatus(data.task_id, 'running');
                    updateLiveOutput(`${data.message}\n`);
                    break;
                    
                case 'task_progress':
                    if (data.partial_result) {
                        updateLiveOutput(data.partial_result);
                    }
                    increaseProgress();
                    break;
                    
                case 'task_completed':
                    updateTaskStatus(data.task_id, 'completed');
                    completedTasks++;
                    completedTasksCount.textContent = completedTasks;
                    
                    const percentComplete = Math.round((completedTasks / totalTasks) * 100);
                    updateProgress(Math.min(percentComplete, 99));
                    break;
                    
                case 'task_error':
                    updateTaskStatus(data.task_id, 'error');
                    updateLiveOutput(`错误: ${data.message}\n`);
                    break;
                    
                case 'completed':
                    hideLoading();
                    showResults(data.result);
                    resetScanButton();
                    currentScanId = null;
                    sessionStorage.removeItem('currentScanId');
                    break;
                    
                case 'error':
                    hideLoading();
                    showError(data.message || data.error);
                    resetScanButton();
                    currentScanId = null;
                    sessionStorage.removeItem('currentScanId');
                    break;
                    
                case 'cancelled':
                    hideLoading();
                    showInfo('扫描已取消');
                    resetScanButton();
                    currentScanId = null;
                    sessionStorage.removeItem('currentScanId');
                    break;
            }
        });
        
        socket.on('disconnect', function() {
            console.log('WebSocket连接已断开');
            isConnected = false;
            updateSocketStatus(false, false);
            
            if (reconnectAttempts < maxReconnectAttempts) {
                console.log(`尝试重新连接 (${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
                reconnectAttempts++;
            } else if (currentScanId) {
                hideLoading();
                showError('与服务器的连接已丢失，无法接收实时扫描更新。请检查您的网络连接并重试。');
                resetScanButton();
            }
        });
    }
    
    function updateSocketStatus(connected, isSecure) {
        const statusIndicator = document.getElementById('socketStatus');
        if (connected) {
            statusIndicator.classList.add('connected');
            statusIndicator.title = isSecure ? 
                '已建立安全WebSocket连接 (WSS)' : 
                '已建立WebSocket连接 (WS)';
            
            if (isSecure) {
                statusIndicator.classList.add('secure');
            } else {
                statusIndicator.classList.remove('secure');
            }
        } else {
            statusIndicator.classList.remove('connected', 'secure');
            statusIndicator.title = '未连接到服务器';
        }
    }
    
    function createTaskCards(tasks) {
        tasksGrid.innerHTML = '';
        
        tasks.forEach(task => {
            const taskCard = document.createElement('div');
            taskCard.className = 'task-item';
            taskCard.id = `task-${task.task_id}`;
            
            taskCard.innerHTML = `
                <div class="task-id">
                    ${task.task_id}
                    <span class="task-status pending" title="等待中"></span>
                </div>
                <div class="task-target" title="${task.target}">
                    <i class="fas fa-crosshairs"></i> ${task.target}
                </div>
                <div class="task-ports" title="${task.ports}">
                    <i class="fas fa-plug"></i> ${task.ports}
                </div>
            `;
            
            tasksGrid.appendChild(taskCard);
            
            // 记录任务状态
            activeTasks[task.task_id] = {
                status: 'pending',
                element: taskCard
            };
        });
    }
    
    // 更新任务状态
    function updateTaskStatus(taskId, status) {
        if (activeTasks[taskId]) {
            activeTasks[taskId].status = status;
            
            const taskCard = document.getElementById(`task-${taskId}`);
            if (taskCard) {
                const statusElement = taskCard.querySelector('.task-status');
                
                // 移除所有状态类
                statusElement.classList.remove('pending', 'running', 'completed', 'error');
                
                // 添加新状态类
                statusElement.classList.add(status);
                
                // 更新提示文本
                statusElement.title = TASK_STATUS[status] || status;
            }
        }
    }
    
    // 加入扫描房间
    function joinScanRoom(scanId) {
        if (socket && socket.connected) {
            socket.emit('join_scan', { scan_id: scanId });
        }
    }
    
    // 端口输入与全端口扫描选项互斥
    scanAllPortsCheckbox.addEventListener('change', function() {
        if (this.checked) {
            portsInput.disabled = true;
            portsInput.placeholder = "已选择全端口扫描";
            portsInput.parentElement.classList.add('disabled');
        } else {
            portsInput.disabled = false;
            portsInput.placeholder = "例如: 80,443 或 1-1000";
            portsInput.parentElement.classList.remove('disabled');
        }
    });
    
    // 为选项添加动画效果
    const scanTypeRadios = document.querySelectorAll('input[name="scan_type"]');
    const scanSpeedRadios = document.querySelectorAll('input[name="scan_speed"]');
    
    function addRadioAnimations(radioButtons) {
        // 清除所有选中样式的函数
        function clearSelectionStyles(name) {
            document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
                const item = radio.closest('.option-item');
                if (item) {
                    item.classList.remove('option-selected');
                }
            });
        }
        
        radioButtons.forEach(radio => {
            radio.addEventListener('change', function() {
                // 清除同组中所有单选按钮的选中样式
                clearSelectionStyles(this.name);
                
                if (this.checked) {
                    const optionItem = this.closest('.option-item');
                    
                    // 添加选中样式
                    optionItem.classList.add('option-selected');
                    
                    // 添加一个简单的选中动画
                    const ripple = document.createElement('span');
                    ripple.classList.add('option-ripple');
                    optionItem.appendChild(ripple);
                    
                    setTimeout(() => {
                        ripple.remove();
                    }, 500);
                }
            });
            
            // 初始化选中状态
            if (radio.checked) {
                radio.closest('.option-item').classList.add('option-selected');
            }
        });
    }
    
    // 初始化单选按钮动画
    addRadioAnimations(scanTypeRadios);
    addRadioAnimations(scanSpeedRadios);
    
    // 表单验证
    target.addEventListener('input', validateForm);
    portsInput.addEventListener('input', validateForm);
    scanAllPortsCheckbox.addEventListener('change', validateForm);
    
    function validateForm() {
        const targetValue = target.value.trim();
        const isValid = targetValue.length > 0;
        
        if (isValid) {
            scanButton.disabled = false;
            target.classList.remove('input-error');
        } else {
            scanButton.disabled = true;
            if (targetValue === '' && target.classList.contains('was-validated')) {
                target.classList.add('input-error');
            }
        }
    }
    
    target.addEventListener('blur', function() {
        this.classList.add('was-validated');
        validateForm();
    });
    
    // 表单提交处理
    scanForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        // 检查WebSocket连接
        if (!socket || !socket.connected) {
            showError('未能连接到扫描服务器，请刷新页面重试');
            return;
        }
        
        // 添加表单提交动画
        scanButton.innerHTML = '<div class="btn-spinner"></div> 扫描中...';
        
        // 收集表单数据
        const targetValue = target.value.trim();
        const ports = portsInput.value.trim();
        const scanAllPorts = scanAllPortsCheckbox.checked;
        const threadCount = parseInt(parallelTasks.value) || DEFAULT_THREADS;
        
        // 获取选中的扫描类型和速度
        const selectedScanType = document.querySelector('input[name="scan_type"]:checked')?.value || "-sS";
        const selectedScanSpeed = document.querySelector('input[name="scan_speed"]:checked')?.value || "-T3";
        const selectedOptions = [selectedScanType, selectedScanSpeed];
        
        // 验证目标
        if (!targetValue) {
            showError('请输入有效的目标地址');
            resetScanButton();
            return;
        }
        
        // 显示加载状态与取消按钮
        showLoading(scanAllPorts);
        cancelButton.style.display = 'inline-block';
        
        // 重置进度和状态
        updateProgress(0);
        completedTasks = 0;
        totalTasks = 0;
        completedTasksCount.textContent = "0";
        totalTasksCount.textContent = "0";
        tasksGrid.innerHTML = '';
        liveOutput.textContent = '等待扫描开始...\n';
        
        // 准备请求数据
        const requestData = {
            target: targetValue,
            ports: ports,
            options: selectedOptions,
            scan_all_ports: scanAllPorts,
            parallel_tasks: threadCount
        };
        
        // 记住最近扫描的目标 (本地存储)
        saveRecentScan(targetValue);
        
        // 使用WebSocket发送扫描请求
        socket.emit('start_scan', requestData);
    });
    
    // 更新进度条
    function updateProgress(percentage) {
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = `${percentage}%`;
    }
    
    // 缓慢增加进度，模拟扫描进展
    function increaseProgress() {
        if (totalTasks === 0) return; // 防止除以零
        
        const currentCompleted = completedTasks;
        const taskPercentage = (currentCompleted / totalTasks) * 100;
        
        // 在任务完成百分比和当前进度条之间找一个中间值
        const currentWidth = parseFloat(progressFill.style.width) || 0;
        
        // 如果实际完成的任务百分比大于进度条，直接更新到任务百分比
        if (taskPercentage > currentWidth) {
            updateProgress(Math.round(taskPercentage));
            return;
        }
        
        // 否则微微增加当前进度
        let increment;
        if (currentWidth < 30) {
            increment = 0.5;
        } else if (currentWidth < 60) {
            increment = 0.3;
        } else if (currentWidth < 80) {
            increment = 0.2;
        } else if (currentWidth < 90) {
            increment = 0.1;
        } else {
            increment = 0.05;
        }
        
        // 不要超过99%，留给最终完成状态
        const newWidth = Math.min(99, currentWidth + increment);
        updateProgress(Math.round(newWidth));
    }
    
    // 更新实时输出
    function updateLiveOutput(text) {
        // 将新文本添加到当前内容
        liveOutput.textContent += text;
        
        // 自动滚动到底部
        liveOutput.scrollTop = liveOutput.scrollHeight;
    }
    
    function resetScanButton() {
        scanButton.innerHTML = '<i class="fas fa-play"></i> 开始扫描';
        cancelButton.style.display = 'none';
    }
    
    // 取消扫描
    cancelButton.addEventListener('click', function() {
        if (currentScanId && socket && socket.connected) {
            socket.emit('cancel_scan', { scan_id: currentScanId });
        }
    });
    
    // 保存最近扫描的目标
    function saveRecentScan(targetValue) {
        let recentScans = JSON.parse(localStorage.getItem('recentScans') || '[]');
        // 避免重复
        recentScans = recentScans.filter(scan => scan !== targetValue);
        recentScans.unshift(targetValue); // 添加到开头
        // 最多保存5个
        recentScans = recentScans.slice(0, 5);
        localStorage.setItem('recentScans', JSON.stringify(recentScans));
    }
    
    // 清除结果按钮
    clearButton.addEventListener('click', function() {
        hideResults();
        hideError();
        
        // 添加清除动画效果
        this.classList.add('btn-active');
        setTimeout(() => {
            this.classList.remove('btn-active');
        }, 300);
    });
    
    // 展示信息提示
    function showInfo(message) {
        // 创建一个临时消息提示
        const infoToast = document.createElement('div');
        infoToast.className = 'info-toast';
        infoToast.innerHTML = `<i class="fas fa-info-circle"></i> ${message}`;
        document.body.appendChild(infoToast);
        
        // 显示动画
        setTimeout(() => {
            infoToast.classList.add('show');
        }, 10);
        
        // 自动消失
        setTimeout(() => {
            infoToast.classList.remove('show');
            setTimeout(() => {
                document.body.removeChild(infoToast);
            }, 300);
        }, 3000);
    }
    
    // 展示加载状态
    function showLoading(isAllPorts) {
        hideResults();
        hideError();
        loading.style.display = 'block';
        scanButton.disabled = true;
        
        // 淡入动画
        loading.style.opacity = 0;
        setTimeout(() => {
            loading.style.opacity = 1;
        }, 10);
        
        // 如果是全端口扫描，显示额外警告
        if (isAllPorts) {
            scanWarning.style.display = 'block';
        } else {
            scanWarning.style.display = 'none';
        }
    }
    
    // 隐藏加载状态
    function hideLoading() {
        loading.style.opacity = 0;
        setTimeout(() => {
            loading.style.display = 'none';
        }, 300);
        scanButton.disabled = false;
    }
    
    // 展示结果
    function showResults(resultText) {
        results.style.display = 'block';
        resultsContent.textContent = resultText;
        
        // 淡入动画
        results.style.opacity = 0;
        setTimeout(() => {
            results.style.opacity = 1;
        }, 10);
        
        // 为结果添加语法高亮
        highlightScanResults();
        
        // 滚动到结果区域
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    // 隐藏结果
    function hideResults() {
        if (results.style.display !== 'none') {
            results.style.opacity = 0;
            setTimeout(() => {
                results.style.display = 'none';
            }, 300);
        }
    }
    
    // 展示错误
    function showError(message) {
        error.style.display = 'block';
        errorMessage.textContent = message;
        
        // 淡入动画
        error.style.opacity = 0;
        setTimeout(() => {
            error.style.opacity = 1;
        }, 10);
        
        // 滚动到错误区域
        error.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    // 隐藏错误
    function hideError() {
        if (error.style.display !== 'none') {
            error.style.opacity = 0;
            setTimeout(() => {
                error.style.display = 'none';
            }, 300);
        }
    }
    
    // 简单的结果高亮
    function highlightScanResults() {
        const content = resultsContent.textContent;
        let highlighted = content;
        
        // 高亮扫描头部
        highlighted = highlighted.replace(/(Starting Nmap.*?)(?=\n)/g, 
            '<span class="hl-header">$1</span>');
        
        // 高亮端口状态表头
        highlighted = highlighted.replace(/(PORT\s+STATE\s+SERVICE)/g, 
            '<span class="hl-table-header">$1</span>');
        
        // 高亮目标标记
        highlighted = highlighted.replace(/(目标: .*?)(?=\n)/g, 
            '<span class="hl-target">$1</span>');
        
        // 高亮端口状态
        highlighted = highlighted.replace(/(\d+\/\w+)\s+(open|closed|filtered)\s+(.*?)(?=\n|$)/g, function(match, port, state, service) {
            let stateClass = 'hl-state-' + state;
            return `<span class="hl-port">${port}</span> <span class="${stateClass}">${state}</span> <span class="hl-service">${service}</span>`;
        });
        
        // 高亮IP地址
        highlighted = highlighted.replace(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g, 
            '<span class="hl-ip">$1</span>');
        
        // 高亮域名
        highlighted = highlighted.replace(/([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z0-9][-a-zA-Z0-9]*/g, function(match) {
            // 避免重复高亮已经处理过的元素
            if (match.includes('<span')) return match;
            return `<span class="hl-domain">${match}</span>`;
        });
        
        // 高亮服务版本信息
        highlighted = highlighted.replace(/(Running|Service Info):(.*?)(?=\n|$)/g, 
            '<span class="hl-service-label">$1:</span><span class="hl-service-info">$2</span>');
        
        // 高亮总结信息
        highlighted = highlighted.replace(/(Nmap 多线程扫描完成:.*?)(?=$)/g, 
            '<span class="hl-summary">$1</span>');
        
        if (highlighted !== content) {
            resultsContent.innerHTML = highlighted;
        }
    }
    
    // 检查是否有之前的扫描
    function checkPreviousScan() {
        const savedScanId = sessionStorage.getItem('currentScanId');
        if (savedScanId) {
            currentScanId = savedScanId;
            showLoading(false);
            updateLiveOutput('正在恢复之前的扫描状态...\n');
            
            // 当WebSocket连接建立后会自动加入此房间
        }
    }
    
    // 初始化
    function init() {
        initWebSocket();
        initThreadControl();
        validateForm();
        checkPreviousScan();
    }
    
    // 启动初始化
    init();
}); 