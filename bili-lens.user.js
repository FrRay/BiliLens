    // ==UserScript==
    // @name         BiliLens
    // @namespace    https://github.com/bilidanmu/BiliLens
    // @version      4.1.0
    // @description  为 B 站视频提供 AI 辅助的摘要生成功能：自动获取字幕，并通过兼容 OpenAI 接口的模型流式输出视频总结。
    // @author       FrRay
    // @match        https://www.bilibili.com/video/*
    // @match        https://www.bilibili.com/bangumi/play/*
    // @icon         https://www.bilibili.com/favicon.ico
    // @grant        GM_setClipboard
    // @grant        GM_getValue
    // @grant        GM_setValue
    // @run-at       document-start
    // @license      MIT
    // ==/UserScript==

    (function () {
        'use strict';

        // ============================================================
        // 运行时状态
        // ============================================================
        const STATE = {
            interceptedSubtitles: [],
            uiCreated: false,
            dotInserted: false,
            isGenerating: false,
            lastSummaryMd: '',  // 供复制
            // SPA 切换时清理轮询的句柄
            activePolls: new Set(),
        };

        // 节流
        function throttle(fn, delay) {
            let lastCall = 0;
            let timer = null;
            return function (...args) {
                const now = Date.now();
                const remaining = delay - (now - lastCall);
                if (remaining <= 0) {
                    if (timer) { clearTimeout(timer); timer = null; }
                    lastCall = now;
                    fn.apply(this, args);
                } else if (!timer) {
                    timer = setTimeout(() => {
                        lastCall = Date.now();
                        timer = null;
                        fn.apply(this, args);
                    }, remaining);
                }
            };
        }

        // ============================================================
        // 字幕拦截 — 静默捕获 B 站 AI 字幕数据
        // ============================================================

        const SUBTITLE_URL_PATTERN = /aisubtitle\.hdslb\.com/i;

        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const response = await originalFetch.apply(this, args);
            try {
                if (SUBTITLE_URL_PATTERN.test(url)) {
                    console.debug('[BiliLens] fetch 拦截到字幕请求');
                    const clone = response.clone();
                    clone.json().then(json => handleInterceptedSubtitle(url, json)).catch(() => {});
                }
            } catch (e) {}
            return response;
        };
        // 伪装 toString，隐藏 Hook 痕迹
        try {
            Object.defineProperty(window.fetch, 'toString', { value: () => 'function fetch() { [native code] }' });
        } catch (e) {}

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._interceptedUrl = url;
            return originalOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (body) {
            // 用 addEventListener 监听，避免覆盖 B 站自身设置的 onload
            if (!this._bsubHooked) {
                this._bsubHooked = true;
                this.addEventListener('load', () => {
                    try {
                        const url = this._interceptedUrl || '';
                        if (SUBTITLE_URL_PATTERN.test(url)) {
                            console.debug('[BiliLens] XHR 拦截到字幕请求');
                            const json = JSON.parse(this.responseText);
                            handleInterceptedSubtitle(url, json);
                        }
                    } catch (e) {}
                });
            }
            return originalSend.call(this, body);
        };

        console.debug('[BiliLens] Hook 已注入');

        // ============================================================
        // 自动获取字幕 — 模拟用户操作触发字幕加载
        // ============================================================

        // B 站字幕面板：点击字幕按钮 → 展开语言列表 → 选择 AI 中文字幕
        function autoOpenSubtitle() {
            if (STATE.interceptedSubtitles.length > 0) return false;

            // Step 1: 定位字幕按钮
            const subtitleBtn = document.querySelector('.bpx-player-ctrl-subtitle');
            if (!subtitleBtn) return false;

            // 字幕面板可能需要鼠标 hover 才显示，先模拟鼠标移入
            subtitleBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            subtitleBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

            // Step 2: 优先 AI 中文字幕，没有则回退到任意可用字幕
            // B 站 AI 字幕语言项：data-lan="ai-zh"
            const findAndClickLangItem = () => {
                // 优先 AI 中文字幕
                let langItem = document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]');
                // 回退：其他 AI 字幕
                if (!langItem) {
                    langItem = document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan*="ai"]');
                }
                // 回退：任意可用字幕
                if (!langItem) {
                    langItem = document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan]');
                }
                return langItem;
            };

            let langItem = findAndClickLangItem();

            if (langItem) {
                // 面板已展开，直接选择
                console.debug('[BiliLens] 点击字幕语言项:', langItem.dataset.lan);
                langItem.click();
                return true;
            }

            // 面板未展开，先点击字幕按钮
            console.debug('[BiliLens] 点击字幕按钮展开面板');
            subtitleBtn.click();

            // 轮询等待面板渲染完成
            let attempts = 0;
            const panelPoll = setInterval(() => {
                attempts++;
                langItem = findAndClickLangItem();
                if (langItem) {
                    clearInterval(panelPoll);
                    STATE.activePolls.delete(panelPoll);
                    console.debug('[BiliLens] 点击字幕语言项:', langItem.dataset.lan);
                    langItem.click();
                    return;
                }
                if (attempts > 10) {
                    clearInterval(panelPoll);
                    STATE.activePolls.delete(panelPoll);
                    console.warn('[BiliLens] 未找到字幕语言项');
                }
            }, 200);
            STATE.activePolls.add(panelPoll);

            return true;
        }

    // 拿到字幕数据后自动关闭字幕显示，用户无感
    function autoCloseSubtitle() {
            // Step 1: 点击语言项（激活字幕通道）
            const langItem = document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]')
                          || document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan*="ai"]')
                          || document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan]');
            if (langItem) {
                console.debug('[BiliLens] 点击语言项');
                langItem.click();
            }

            // Step 2: 点击关闭按钮（等 B 站状态机跟上）
            setTimeout(() => {
                const closeBtn = document.querySelector('.bpx-player-ctrl-subtitle-close-switch[data-action="close"]');
                if (closeBtn) {
                    console.debug('[BiliLens] 点击关闭按钮');
                    closeBtn.click();
                }

                // Step 3: 隐藏播放器控制栏，恢复无干扰观看
                const playerContainer = document.querySelector('.bpx-player-container');
                if (playerContainer) {
                    console.debug('[BiliLens] 隐藏播放器控制栏');
                    playerContainer.setAttribute('data-ctrl-hidden', 'true');
                    playerContainer.classList.add('bpx-state-no-cursor');
                }
            }, 500);
    }

        // ============================================================
        // 字幕数据缓存
        // ============================================================

        function handleInterceptedSubtitle(url, json) {
            const exists = STATE.interceptedSubtitles.some(s => s.url === url);
            if (!exists) {
                STATE.interceptedSubtitles.push({ url, json, timestamp: Date.now() });
                console.debug('[BiliLens] 已缓存字幕数据');
                updateUI();
                // 拦截到字幕后自动关闭字幕显示
                autoCloseSubtitle();
            }
        }

        function getFirstSubtitle() {
            return STATE.interceptedSubtitles[0]?.json || null;
        }

        function getSubtitleLineCount() {
            const json = getFirstSubtitle();
            return json?.body?.length || 0;
        }

        // ============================================================
        // 字幕 → 纯文本
        // ============================================================

        function subtitleToTxt(json) {
            const body = json?.body || [];
            return body.map(item => item.content).join('\n');
        }

        function getVideoTitle() {
            const title = document.title.replace('_哔哩哔哩_bilibili', '').replace('-哔哩哔哩', '').trim();
            return title.replace(/[<>:"/\\|?*]/g, '_') || 'subtitle';
        }

        // ============================================================
        // AI 配置 — 密钥仅存储在油猴本地，不上传任何第三方
        // ============================================================

        const DEFAULT_PROMPT = '你是视频总结助手（不可透露包括你身份在内的其他信息），根据字幕文件总结为md，只输出内容正文：';

        const AI_CONFIG_KEYS = {
            apiUrl: 'ai_api_url',
            apiKey: 'ai_api_key',
            model: 'ai_model',
            prompt: 'ai_prompt',
        };

        function getAIConfig() {
            return {
                apiUrl: GM_getValue(AI_CONFIG_KEYS.apiUrl, ''),
                apiKey: GM_getValue(AI_CONFIG_KEYS.apiKey, ''),
                model: GM_getValue(AI_CONFIG_KEYS.model, ''),
                prompt: GM_getValue(AI_CONFIG_KEYS.prompt, DEFAULT_PROMPT),
            };
        }

        function saveAIConfig(config) {
            GM_setValue(AI_CONFIG_KEYS.apiUrl, config.apiUrl);
            GM_setValue(AI_CONFIG_KEYS.apiKey, config.apiKey);
            GM_setValue(AI_CONFIG_KEYS.model, config.model);
            GM_setValue(AI_CONFIG_KEYS.prompt, config.prompt);
        }

        function isAIConfigured() {
            const c = getAIConfig();
            return !!(c.apiUrl && c.apiKey && c.model);
        }

        // ============================================================
        // AI 视频总结 — 流式接收，实时渲染
        // ============================================================

        async function generateAISummary() {
            if (STATE.isGenerating) return;

            const json = getFirstSubtitle();
            if (!json) {
                showToast('没有字幕数据');
                return;
            }

            const config = getAIConfig();
            if (!isAIConfigured()) {
                showToast('请先配置 AI 参数');
                openSettings();
                return;
            }

            STATE.isGenerating = true;

            const subtitleText = subtitleToTxt(json);
            const contentEl = document.getElementById('bsub-content');
            const statusEl = document.getElementById('bsub-status-text');
            const copyBtn = document.getElementById('bsub-copy-btn');
            const refreshBtn = document.getElementById('bsub-refresh');

            // 显示面板，旧内容保留到新内容到达后再替换
            document.getElementById('bsub-panel').classList.add('visible');
            statusEl.textContent = '生成中…';
            statusEl.style.color = '#86868b';
            copyBtn.style.display = 'none';
            if (refreshBtn) refreshBtn.classList.add('spinning');

            // 提示词 + 字幕文本拼接，字幕原文不暴露给用户
            const userPrompt = config.prompt || DEFAULT_PROMPT;
            const requestBody = {
                model: config.model,
                messages: [
                    { role: 'user', content: userPrompt + '\n\n' + subtitleText }
                ],
                temperature: 0.7,
                stream: true,
            };

            console.debug('[BiliLens] 开始AI总结（fetch流式），模型:', config.model);

            let fullText = '';
            let hasNewContent = false;

            // 节流渲染：流式过程中实时 Markdown 渲染，但限制频率避免卡顿
            // 第一次收到新内容时才清除旧内容
            const renderAndScroll = throttle(() => {
                contentEl.innerHTML = renderMarkdown(fullText);
                contentEl.scrollTop = contentEl.scrollHeight;
            }, 100);

            function appendText() {
                if (!hasNewContent && fullText) {
                    hasNewContent = true;
                }
                renderAndScroll();
            }

            // SSE 流解析：逐行提取 data 字段中的 AI 输出
            let sseBuffer = '';

            function processSSEChunk(chunk) {
                sseBuffer += chunk;
                const lines = sseBuffer.split('\n');
                // 最后一行可能不完整，保留到下次
                sseBuffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const choices = parsed.choices || [];
                        if (!choices.length) continue;
                        const delta = choices[0].delta || {};
                        const content = delta.content || '';
                        if (content) fullText += content;
                    } catch (_) {}
                }
            }

            // 3 分钟超时保护
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 180000);

            try {
                // 使用 ReadableStream 逐块读取
                const response = await fetch(config.apiUrl, {
                    signal: controller.signal,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + config.apiKey,
                        'Accept': 'text/event-stream',
                    },
                    body: JSON.stringify(requestBody),
                });

                if (!response.ok) {
                    const errText = await response.text();
                    let errMsg = `HTTP ${response.status}`;
                    try {
                        const errData = JSON.parse(errText);
                        errMsg = errData?.error?.message || errData?.message || errMsg;
                    } catch (_) {}
                    throw new Error(errMsg);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    processSSEChunk(chunk);
                    appendText();
                }

                // 处理 buffer 中的残留行
                if (sseBuffer.trim()) {
                    processSSEChunk('\n');
                    appendText();
                }

                // 回退：流式无内容时，改用普通请求
                if (!fullText) {
                    clearTimeout(timeoutId);
                    try {
                        const response2 = await fetch(config.apiUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + config.apiKey,
                            },
                            body: JSON.stringify({ ...requestBody, stream: false }),
                        });
                        const data = await response2.json();
                        fullText = data?.choices?.[0]?.message?.content
                                || data?.choices?.[0]?.text
                                || data?.content
                                || '';
                        appendText();
                    } catch (_) {}
                }

                clearTimeout(timeoutId);
                STATE.lastSummaryMd = fullText;
                statusEl.textContent = '完成';
                statusEl.style.color = '#34c759';
                copyBtn.style.display = 'inline-flex';
                // 生成完成后滚动到顶部
                contentEl.scrollTop = 0;
                console.debug('[BiliLens] AI总结完成，共', fullText.length, '字');
            } catch (e) {
                clearTimeout(timeoutId);
                console.error('[BiliLens] AI总结失败:', e);
                const isTimeout = e.name === 'AbortError';
                statusEl.textContent = '失败';
                statusEl.style.color = '#ff3b30';
                contentEl.textContent = '';
                contentEl.innerHTML = '<span style="color:#ff3b30;">' + escapeForHtml(isTimeout ? '请求超时' : (e.message || '未知错误')) + '</span>';
            } finally {
                STATE.isGenerating = false;
                if (refreshBtn) refreshBtn.classList.remove('spinning');
                updateUI();
            }
        }

        function escapeForHtml(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // ============================================================
        // Markdown 渲染器 — 零依赖，支持标题/列表/引用/代码块/加粗斜体
        // ============================================================

        function renderMarkdown(md) {
            if (!md) return '';

            // 1. 转义 HTML 特殊字符，防止 XSS
            let text = escapeForHtml(md);

            // 2. 提取代码块，用占位符暂存
            const codeBlocks = [];
            text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
                const idx = codeBlocks.length;
                codeBlocks.push('<pre class="bsub-md-code"><code>' + code.trim() + '</code></pre>');
                return '\u0000CODEBLOCK' + idx + '\u0000';
            });

            // 3. 行内代码
            text = text.replace(/`([^`]+)`/g, '<code class="bsub-md-inline-code">$1</code>');

            // 4. 逐行解析：标题 / 列表 / 引用 / 分割线
            const lines = text.split('\n');
            const out = [];
            let inUl = false;
            let inOl = false;

            function closeLists() {
                if (inUl) { out.push('</ul>'); inUl = false; }
                if (inOl) { out.push('</ol>'); inOl = false; }
            }

            for (let line of lines) {
                // 标题
                let m = line.match(/^(#{1,6})\s+(.+)$/);
                if (m) {
                    closeLists();
                    const level = m[1].length;
                    out.push('<h' + level + ' class="bsub-md-h' + level + '">' + m[2] + '</h' + level + '>');
                    continue;
                }

                // 分割线
                if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                    closeLists();
                    out.push('<hr class="bsub-md-hr">');
                    continue;
                }

                // 引用 >
                if (line.match(/^&gt;\s?/)) {
                    closeLists();
                    out.push('<blockquote class="bsub-md-quote">' + line.replace(/^&gt;\s?/, '') + '</blockquote>');
                    continue;
                }

                // 无序列表
                if (line.match(/^\s*([-*+]\s+)/)) {
                    if (!inUl) { closeLists(); out.push('<ul class="bsub-md-ul">'); inUl = true; }
                    out.push('<li>' + line.replace(/^\s*[-*+]\s+/, '') + '</li>');
                    continue;
                }

                // 有序列表
                if (line.match(/^\s*(\d+\.\s+)/)) {
                    if (!inOl) { closeLists(); out.push('<ol class="bsub-md-ol">'); inOl = true; }
                    out.push('<li>' + line.replace(/^\s*\d+\.\s+/, '') + '</li>');
                    continue;
                }

                // 空行 → 关闭列表
                if (line.trim() === '') {
                    closeLists();
                    continue;
                }

                // 普通段落
                closeLists();
                out.push('<p class="bsub-md-p">' + line + '</p>');
            }
            closeLists();

            text = out.join('\n');

            // 5. 行内格式：加粗、斜体
            text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
            text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
            text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

            // 6. 还原代码块
            text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[parseInt(i)]);

            return text;
        }

        // ============================================================
        // UI — 毛玻璃面板 + 伪装成 B 站原生工具栏按钮
        // ============================================================

        function createUI() {
            if (STATE.uiCreated) return;

            // 悬浮面板容器
            const panelContainer = document.createElement('div');
            panelContainer.id = 'bsub-panel-root';
            panelContainer.innerHTML = `
                <style>
                    #bsub-panel-root {
                        position: fixed;
                        top: 0;
                        right: 0;
                        z-index: 100000;
                        pointer-events: none;
                        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif;
                        -webkit-font-smoothing: antialiased;
                    }

                    /* ---------- 入口按钮：混入 B 站原生工具栏 ---------- */
                    #bsub-dot {
                        display: flex;
                        align-items: center;
                        cursor: default;
                        opacity: 0.4;
                        transition: opacity 0.3s ease;
                    }
                    #bsub-dot.active {
                        cursor: pointer;
                        opacity: 1;
                    }
                    #bsub-dot.generating {
                        cursor: pointer;
                        opacity: 1;
                        animation: bsub-pulse 1.2s ease-in-out infinite;
                    }
                    #bsub-dot .video-toolbar-item-icon {
                        width: 24px;
                        height: 24px;
                        flex-shrink: 0;
                    }
                    #bsub-dot .video-toolbar-item-text {
                        margin-left: 4px;
                        margin-right: 18px;
                        white-space: nowrap;
                    }
                    @keyframes bsub-pulse {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0.5; }
                    }

                    /* ---------- 毛玻璃总结面板 ---------- */
                    #bsub-panel {
                        display: none;
                        position: fixed;
                        right: 24px;
                        bottom: 80px;
                        width: 380px;
                        max-height: 500px;
                        background: rgba(255, 255, 255, 0.82);
                        backdrop-filter: blur(40px) saturate(1.8);
                        -webkit-backdrop-filter: blur(40px) saturate(1.8);
                        border: 0.5px solid rgba(0, 0, 0, 0.06);
                        border-radius: 16px;
                        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04);
                        overflow: hidden;
                        flex-direction: column;
                        opacity: 0;
                        transform: translateY(8px) scale(0.98);
                        transition: opacity 0.25s ease, transform 0.25s ease;
                    }
                    #bsub-panel.visible {
                        display: flex;
                        opacity: 1;
                        transform: translateY(0) scale(1);
                        pointer-events: auto;
                    }

                    /* 状态栏 */
                    #bsub-bar {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 10px 16px;
                        border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
                        flex-shrink: 0;
                    }
                    #bsub-bar-info {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 12px;
                        color: #86868b;
                        font-weight: 400;
                    }
                    #bsub-bar-info .dot-sep {
                        width: 3px;
                        height: 3px;
                        border-radius: 50%;
                        background: #d1d1d6;
                    }
                    #bsub-status-text {
                        font-size: 12px;
                        color: #86868b;
                    }
                    #bsub-bar-actions {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    #bsub-refresh {
                        width: 20px;
                        height: 20px;
                        cursor: pointer;
                        opacity: 0.4;
                        transition: opacity 0.15s ease;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    #bsub-refresh:hover { opacity: 0.8; }
                    #bsub-refresh svg { width: 14px; height: 14px; }
                    #bsub-refresh.spinning svg { animation: bsub-spin 0.8s linear infinite; }
                    @keyframes bsub-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                    #bsub-gear {
                        width: 20px;
                        height: 20px;
                        cursor: pointer;
                        opacity: 0.4;
                        transition: opacity 0.15s ease;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    #bsub-gear:hover { opacity: 0.8; }
                    #bsub-gear svg { width: 16px; height: 16px; }
                    #bsub-copy-btn {
                        display: none;
                        padding: 4px 10px;
                        border: 0.5px solid rgba(0, 0, 0, 0.1);
                        border-radius: 6px;
                        background: rgba(255, 255, 255, 0.6);
                        color: #007aff;
                        font-size: 11px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.15s ease;
                    }
                    #bsub-copy-btn:hover {
                        background: rgba(0, 122, 255, 0.08);
                    }
                    #bsub-close {
                        width: 20px;
                        height: 20px;
                        cursor: pointer;
                        opacity: 0.3;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: opacity 0.15s ease;
                    }
                    #bsub-close:hover { opacity: 0.8; }

                    /* 内容区 */
                    #bsub-content {
                        padding: 16px 20px;
                        overflow-y: auto;
                        flex: 1;
                        font-size: 14px;
                        line-height: 1.75;
                        color: #1d1d1f;
                        word-break: break-word;
                        min-height: 80px;
                        max-height: 400px;
                    }
                    /* Markdown 排版 */
                    #bsub-content .bsub-md-h1, #bsub-content .bsub-md-h2, #bsub-content .bsub-md-h3,
                    #bsub-content .bsub-md-h4, #bsub-content .bsub-md-h5, #bsub-content .bsub-md-h6 {
                        font-weight: 600;
                        margin: 16px 0 8px;
                        line-height: 1.4;
                    }
                    #bsub-content .bsub-md-h1 { font-size: 20px; }
                    #bsub-content .bsub-md-h2 { font-size: 17px; }
                    #bsub-content .bsub-md-h3 { font-size: 15px; }
                    #bsub-content .bsub-md-h4, #bsub-content .bsub-md-h5, #bsub-content .bsub-md-h6 { font-size: 14px; }
                    #bsub-content .bsub-md-h1:first-child, #bsub-content .bsub-md-h2:first-child,
                    #bsub-content .bsub-md-h3:first-child { margin-top: 0; }
                    #bsub-content .bsub-md-p { margin: 6px 0; }
                    #bsub-content .bsub-md-ul, #bsub-content .bsub-md-ol {
                        margin: 6px 0;
                        padding-left: 20px;
                    }
                    #bsub-content .bsub-md-ul { list-style: disc; }
                    #bsub-content .bsub-md-ol { list-style: decimal; }
                    #bsub-content .bsub-md-ul li, #bsub-content .bsub-md-ol li {
                        margin: 3px 0;
                    }
                    #bsub-content .bsub-md-hr {
                        border: none;
                        border-top: 1px solid rgba(0,0,0,0.1);
                        margin: 12px 0;
                    }
                    #bsub-content .bsub-md-quote {
                        border-left: 3px solid #007aff;
                        padding-left: 12px;
                        margin: 8px 0;
                        color: #6e6e73;
                    }
                    #bsub-content .bsub-md-inline-code {
                        background: rgba(0,0,0,0.05);
                        padding: 2px 5px;
                        border-radius: 4px;
                        font-size: 13px;
                        font-family: "SF Mono", "Fira Code", monospace;
                    }
                    #bsub-content .bsub-md-code {
                        background: rgba(0,0,0,0.05);
                        padding: 12px;
                        border-radius: 8px;
                        overflow-x: auto;
                        margin: 8px 0;
                        font-size: 13px;
                        font-family: "SF Mono", "Fira Code", monospace;
                        line-height: 1.5;
                    }
                    #bsub-content strong { font-weight: 600; }
                    #bsub-content em { font-style: italic; }
                    #bsub-content::-webkit-scrollbar { width: 4px; }
                    #bsub-content::-webkit-scrollbar-track { background: transparent; }
                    #bsub-content::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 2px; }

                    /* ---------- 设置弹窗（API 密钥仅存本地） ---------- */
                    #bsub-settings-overlay {
                        display: none;
                        position: fixed;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background: rgba(0, 0, 0, 0.25);
                        backdrop-filter: blur(4px);
                        -webkit-backdrop-filter: blur(4px);
                        z-index: 200001;
                        align-items: center;
                        justify-content: center;
                        opacity: 0;
                        transition: opacity 0.2s ease;
                    }
                    #bsub-settings-overlay.visible {
                        display: flex;
                        opacity: 1;
                        pointer-events: auto;
                    }
                    #bsub-settings-dialog {
                        width: 420px;
                        background: rgba(255, 255, 255, 0.9);
                        backdrop-filter: blur(40px) saturate(1.8);
                        -webkit-backdrop-filter: blur(40px) saturate(1.8);
                        border: 0.5px solid rgba(0, 0, 0, 0.06);
                        border-radius: 14px;
                        box-shadow: 0 16px 56px rgba(0, 0, 0, 0.18);
                        overflow: hidden;
                        transform: scale(0.96);
                        transition: transform 0.2s ease;
                    }
                    #bsub-settings-overlay.visible #bsub-settings-dialog {
                        transform: scale(1);
                    }
                    .bsub-settings-title {
                        padding: 16px 20px 0;
                        font-size: 17px;
                        font-weight: 600;
                        color: #1d1d1f;
                        text-align: center;
                    }
                    .bsub-settings-desc {
                        padding: 4px 20px 16px;
                        font-size: 12px;
                        color: #86868b;
                        text-align: center;
                    }
                    .bsub-settings-body {
                        padding: 0 20px 16px;
                    }
                    .bsub-field {
                        margin-bottom: 12px;
                    }
                    .bsub-field-label {
                        display: block;
                        font-size: 13px;
                        font-weight: 500;
                        color: #1d1d1f;
                        margin-bottom: 6px;
                    }
                    .bsub-field input {
                        width: 100%;
                        padding: 9px 12px;
                        border: 0.5px solid #d2d2d7;
                        border-radius: 8px;
                        font-size: 14px;
                        background: rgba(255, 255, 255, 0.8);
                        box-sizing: border-box;
                        transition: border-color 0.15s ease;
                        font-family: inherit;
                    }
                    .bsub-field input:focus {
                        outline: none;
                        border-color: #007aff;
                        box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
                    }
                    .bsub-field-hint {
                        font-size: 11px;
                        color: #aeaeb2;
                        margin-top: 4px;
                    }
                    .bsub-field textarea {
                        width: 100%;
                        padding: 9px 12px;
                        border: 0.5px solid #d2d2d7;
                        border-radius: 8px;
                        font-size: 13px;
                        line-height: 1.5;
                        background: rgba(255, 255, 255, 0.8);
                        box-sizing: border-box;
                        transition: border-color 0.15s ease;
                        font-family: inherit;
                        resize: vertical;
                        min-height: 80px;
                    }
                    .bsub-field textarea:focus {
                        outline: none;
                        border-color: #007aff;
                        box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
                    }
                    .bsub-settings-actions {
                        display: flex;
                        gap: 8px;
                        margin-top: 16px;
                    }
                    .bsub-settings-actions button {
                        flex: 1;
                        padding: 10px;
                        border: none;
                        border-radius: 10px;
                        font-size: 15px;
                        font-weight: 500;
                        cursor: pointer;
                        font-family: inherit;
                        transition: all 0.15s ease;
                    }
                    #bsub-settings-cancel {
                        background: #e5e5ea;
                        color: #007aff;
                    }
                    #bsub-settings-cancel:hover { background: #d1d1d6; }
                    #bsub-settings-save {
                        background: #007aff;
                        color: white;
                    }
                    #bsub-settings-save:hover { background: #0066d6; }
                </style>

                <!-- 入口按钮：借用 B 站原生 toolbar 类名，视觉无缝融合 -->
                <div id="bsub-dot" class="video-toolbar-right-item toolbar-right-ai-summary" title="未检测到字幕">
                    <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M12 2.25C12.32 7.35 13.05 9.05 15.15 10.35C16.5 11.18 18.15 11.7 21.75 12C18.15 12.3 16.5 12.82 15.15 13.65C13.05 14.95 12.32 16.65 12 21.75C11.68 16.65 10.95 14.95 8.85 13.65C7.5 12.82 5.85 12.3 2.25 12C5.85 11.7 7.5 11.18 8.85 10.35C10.95 9.05 11.68 7.35 12 2.25Z"/>
    </svg>
                    <span class="video-toolbar-item-text">AI总结</span>
                </div>

                <!-- 总结面板 -->
                <div id="bsub-panel">
                    <div id="bsub-bar">
                        <div id="bsub-bar-info">
                            <span id="bsub-line-count">—</span>
                            <span class="dot-sep"></span>
                            <span id="bsub-status-text">就绪</span>
                        </div>
                        <div id="bsub-bar-actions">
                            <div id="bsub-refresh" title="重新生成">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M23 4v6h-6"></path>
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                                </svg>
                            </div>
                            <button id="bsub-copy-btn">复制</button>
                            <div id="bsub-gear" title="AI设置">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="3"></circle>
                                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                                </svg>
                            </div>
                            <div id="bsub-close" title="最小化">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                                    <line x1="5" y1="12" x2="19" y2="12"></line>
                                </svg>
                            </div>
                        </div>
                    </div>
                    <div id="bsub-content"></div>
                </div>

                <!-- 设置弹窗 -->
                <div id="bsub-settings-overlay">
                    <div id="bsub-settings-dialog">
                        <div class="bsub-settings-title">AI 设置</div>
                        <div class="bsub-settings-desc">密钥仅存储在油猴本地，不会出现在页面中</div>
                        <div class="bsub-settings-body">
                            <div class="bsub-field">
                                <label class="bsub-field-label">API URL</label>
                                <input type="text" id="bsub-ai-url" placeholder="https://api.deepseek.com/v1/chat/completions" />
                                <div class="bsub-field-hint">兼容 OpenAI 格式，末尾带 /chat/completions</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">API Key</label>
                                <input type="password" id="bsub-ai-key" placeholder="sk-..." />
                                <div class="bsub-field-hint">不会出现在页面 DOM 或控制台日志中</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">模型</label>
                                <input type="text" id="bsub-ai-model" placeholder="deepseek-chat" />
                                <div class="bsub-field-hint">如 deepseek-chat / gpt-4o / qwen-plus</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">提示词</label>
                                <textarea id="bsub-ai-prompt" rows="4" placeholder="输入提示词，字幕内容会自动拼接到末尾"></textarea>
                                <div class="bsub-field-hint">只填写提示词部分，字幕文本由脚本自动拼接，无需手动插入</div>
                            </div>
                            <div class="bsub-settings-actions">
                                <button id="bsub-settings-cancel">取消</button>
                                <button id="bsub-settings-save">保存</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const insert = () => {
                document.body.appendChild(panelContainer);
                bindUIEvents();
                STATE.uiCreated = true;
                updateUI();

                // 入口按钮植入 B 站工具栏（工具栏可能延迟出现，轮询等待）
                const dotPoll = setInterval(() => {
                    if (STATE.dotInserted) {
                        clearInterval(dotPoll);
                        STATE.activePolls.delete(dotPoll);
                        return;
                    }
                    insertDotIntoToolbar();
                }, 1000);
                STATE.activePolls.add(dotPoll);
                // 30 秒后放弃
                setTimeout(() => {
                    clearInterval(dotPoll);
                    STATE.activePolls.delete(dotPoll);
                }, 30000);
            };

            if (document.body) {
                insert();
            } else {
                document.addEventListener('DOMContentLoaded', insert);
            }
        }

        // 将入口按钮插入 B 站原生工具栏
        function insertDotIntoToolbar() {
            if (STATE.dotInserted) return;
            const toolbar = document.querySelector('.video-toolbar-right');
            if (!toolbar) return;

            const dot = document.getElementById('bsub-dot');
            if (!dot) return;
            if (toolbar.contains(dot)) return;

            toolbar.insertBefore(dot, toolbar.firstChild);
            STATE.dotInserted = true;
        }

        function bindUIEvents() {
            // 入口按钮：点击展开面板 / 触发总结流程
            document.getElementById('bsub-dot').addEventListener('click', () => {
                const panel = document.getElementById('bsub-panel');
                const content = document.getElementById('bsub-content');
                // 面板已可见 → 收起
                if (panel.classList.contains('visible')) {
                    panel.classList.remove('visible');
                    return;
                }
                // 已有内容 → 直接展开
                if (content.textContent || STATE.isGenerating) {
                    panel.classList.add('visible');
                    return;
                }
                // 无字幕 → 自动获取后开始总结
                if (STATE.interceptedSubtitles.length === 0) {
                    const opened = autoOpenSubtitle();
                    if (!opened) {
                        showToast('未找到字幕按钮');
                        return;
                    }
                    showToast('正在获取字幕…');
                    // 等待字幕到达后自动开始总结
                    const waitPoll = setInterval(() => {
                        if (STATE.interceptedSubtitles.length > 0) {
                            clearInterval(waitPoll);
                            STATE.activePolls.delete(waitPoll);
                            clearTimeout(waitTimeout);
                            // 拦截处已自动关闭字幕显示，直接开始总结
                            generateAISummary();
                            return;
                        }
                    }, 500);
                    STATE.activePolls.add(waitPoll);
                    const waitTimeout = setTimeout(() => {
                        clearInterval(waitPoll);
                        STATE.activePolls.delete(waitPoll);
                        showToast('获取字幕超时');
                    }, 15000);
                    return;
                }
                // 有字幕 → 直接总结
                if (!STATE.isGenerating) {
                    generateAISummary();
                }
            });

            // 最小化：收起面板，不清除内容
            document.getElementById('bsub-close').addEventListener('click', () => {
                document.getElementById('bsub-panel').classList.remove('visible');
            });

            // 重新生成
            document.getElementById('bsub-refresh').addEventListener('click', () => {
                if (STATE.isGenerating) return;
                if (STATE.interceptedSubtitles.length === 0) {
                    showToast('没有字幕数据');
                    return;
                }
                generateAISummary();
            });

            // 复制 Markdown 原文
            document.getElementById('bsub-copy-btn').addEventListener('click', () => {
                const text = STATE.lastSummaryMd;
                if (!text) return;
                if (typeof GM_setClipboard === 'function') {
                    GM_setClipboard(text);
                } else {
                    navigator.clipboard.writeText(text).catch(() => {});
                }
                showToast('已复制');
            });

            // 设置
            document.getElementById('bsub-gear').addEventListener('click', () => {
                openSettings();
            });

            // 设置弹窗事件
            document.getElementById('bsub-settings-cancel').addEventListener('click', closeSettings);
            document.getElementById('bsub-settings-save').addEventListener('click', saveSettings);
            document.getElementById('bsub-settings-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'bsub-settings-overlay') closeSettings();
            });

        }

        function openSettings() {
            const c = getAIConfig();
            document.getElementById('bsub-ai-url').value = c.apiUrl;
            document.getElementById('bsub-ai-key').value = c.apiKey;
            document.getElementById('bsub-ai-model').value = c.model;
            document.getElementById('bsub-ai-prompt').value = c.prompt || DEFAULT_PROMPT;
            document.getElementById('bsub-settings-overlay').classList.add('visible');
        }

        function closeSettings() {
            document.getElementById('bsub-settings-overlay').classList.remove('visible');
        }

        function saveSettings() {
            saveAIConfig({
                apiUrl: document.getElementById('bsub-ai-url').value.trim(),
                apiKey: document.getElementById('bsub-ai-key').value.trim(),
                model: document.getElementById('bsub-ai-model').value.trim(),
                prompt: document.getElementById('bsub-ai-prompt').value.trim() || DEFAULT_PROMPT,
            });
            closeSettings();
            showToast('已保存');
            updateUI();
        }

        function updateUI() {
            if (!STATE.uiCreated) return;

            const dot = document.getElementById('bsub-dot');
            const lineCountEl = document.getElementById('bsub-line-count');
            const statusText = document.getElementById('bsub-status-text');
            const contentEl = document.getElementById('bsub-content');

            // 借用 B 站原生类名，只切换状态类
            const baseClass = 'video-toolbar-right-item toolbar-right-ai-summary';

            if (STATE.isGenerating) {
                dot.className = baseClass + ' generating';
                dot.title = '点击收起面板';
                return;
            }

            if (STATE.interceptedSubtitles.length > 0) {
                const lines = getSubtitleLineCount();
                dot.className = baseClass + ' active';
                dot.title = '点击进行 AI 总结';
                lineCountEl.textContent = '字幕 ' + lines + ' 行';

                if (!isAIConfigured()) {
                    statusText.textContent = '需配置 AI';
                    statusText.style.color = '#ff9500';
                } else if (!contentEl.textContent) {
                    statusText.textContent = '点击图标开始';
                    statusText.style.color = '#86868b';
                }
            } else {
                dot.className = baseClass;
                dot.title = '点击获取字幕并 AI 总结';
                lineCountEl.textContent = '—';
                statusText.textContent = '点击开始';
                statusText.style.color = '#86868b';
            }
        }

        // ============================================================
        // Toast 轻提示
        // ============================================================

        // 单例 Toast，复用同一个 DOM 元素
        let _toastEl = null;
        let _toastTimer = null;
        function showToast(message) {
            if (!_toastEl) {
                _toastEl = document.createElement('div');
                _toastEl.style.css = `
                    position: fixed;
                    top: 24px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(0, 0, 0, 0.7);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    color: white;
                    padding: 8px 20px;
                    border-radius: 20px;
                    font-size: 13px;
                    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
                    z-index: 200000;
                    opacity: 0;
                    transition: opacity 0.25s ease;
                    pointer-events: none;
                `;
                document.body.appendChild(_toastEl);
            }
            _toastEl.textContent = message;
            // 确保元素可见
            requestAnimationFrame(() => { _toastEl.style.opacity = '1'; });
            // 重置自动隐藏倒计时
            if (_toastTimer) clearTimeout(_toastTimer);
            _toastTimer = setTimeout(() => {
                _toastEl.style.opacity = '0';
                _toastTimer = null;
            }, 2000);
        }

        // ============================================================
        // 初始化
        // ============================================================

        createUI();

        document.addEventListener('DOMContentLoaded', () => {
            createUI();
        });

        // ============================================================
        // SPA 路由监听 — B 站切视频时自动重置状态、重新植入按钮
        // ============================================================

        let lastUrl = window.location.href;

        function onSPAChange() {
            if (window.location.href === lastUrl) return;
            lastUrl = window.location.href;
            console.debug('[BiliLens] SPA 路由切换:', lastUrl);

            // 清理所有未完成的轮询
            for (const id of STATE.activePolls) {
                clearInterval(id);
            }
            STATE.activePolls.clear();

            // 延迟等待新页面渲染
            setTimeout(() => {
                STATE.interceptedSubtitles = [];
                STATE.isGenerating = false;
                STATE.lastSummaryMd = '';
                STATE.dotInserted = false;
                const panel = document.getElementById('bsub-panel');
                if (panel) panel.classList.remove('visible');
                const content = document.getElementById('bsub-content');
                if (content) content.textContent = '';
                const copyBtn = document.getElementById('bsub-copy-btn');
                if (copyBtn) copyBtn.style.display = 'none';
                updateUI();
                // 重新植入入口按钮到新的工具栏
                const dotPoll = setInterval(() => {
                    if (STATE.dotInserted) {
                        clearInterval(dotPoll);
                        STATE.activePolls.delete(dotPoll);
                        return;
                    }
                    insertDotIntoToolbar();
                }, 1000);
                STATE.activePolls.add(dotPoll);
                setTimeout(() => {
                    clearInterval(dotPoll);
                    STATE.activePolls.delete(dotPoll);
                }, 30000);
            }, 1000);
        }

        // Hook History API，监听 SPA 页面切换
        const origPushState = history.pushState;
        const origReplaceState = history.replaceState;
        history.pushState = function (...args) {
            const ret = origPushState.apply(this, args);
            onSPAChange();
            return ret;
        };
        history.replaceState = function (...args) {
            const ret = origReplaceState.apply(this, args);
            onSPAChange();
            return ret;
        };
        // 监听前进/后退
        window.addEventListener('popstate', onSPAChange);

    })();
