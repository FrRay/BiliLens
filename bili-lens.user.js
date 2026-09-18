    // ==UserScript==
    // @name         BiliLens
    // @namespace    https://github.com/bilidanmu/BiliLens
    // @version      4.14.2
    // @description  为 B 站视频提供 AI 辅助的摘要生成功能：自动获取字幕，并通过兼容 OpenAI 接口的模型流式输出视频总结。
    // @author       FrRay
    // @match        https://www.bilibili.com/video/*
    // @match        https://www.bilibili.com/bangumi/play/*
    // @icon         https://www.bilibili.com/favicon.ico
    // @grant        GM_setClipboard
    // @grant        GM_getValue
    // @grant        GM_setValue
    // @license      Apache License 2.0
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
            toolbarObserver: null,
            toolbarObserverRoot: null,
            isGenerating: false,
            summaryRequest: null,
            lastSummaryMd: '',  // 供复制
            isFetchingSubtitle: false,
            subtitleFetchFailed: false,
            subtitleCopyResetTimer: null,
            // SPA 切换时清理轮询的句柄
            activePolls: new Set(),
        };

        // ============================================================
        // 字幕拦截 — 静默捕获 B 站 AI 字幕数据
        // ============================================================

        const SUBTITLE_URL_PATTERN = /aisubtitle\.hdslb\.com/i;
        let subtitleRequestHooksInstalled = false;
        const SUBTITLE_PREFERENCES = {
            'ai-zh': 'AI 中文字幕优先',
            ai: '任意 AI 字幕优先',
            original: '原始字幕优先',
            any: '任意可用字幕',
        };

        // 仅在用户主动获取字幕时安装，避免影响播放页初始资源请求。
        function installSubtitleRequestHooks() {
            if (subtitleRequestHooksInstalled) return;
            subtitleRequestHooksInstalled = true;

            const originalFetch = window.fetch;
            // 必须原样返回 B 站创建的 Promise，不能用 async 包装它，否则会改变所有请求的时序。
            window.fetch = function (...args) {
                const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const responsePromise = originalFetch.apply(this, args);
                try {
                    if (SUBTITLE_URL_PATTERN.test(url)) {
                        responsePromise.then(response => {
                            console.debug('[BiliLens] fetch 拦截到字幕请求');
                            return response.clone().json();
                        }).then(json => handleInterceptedSubtitle(url, json)).catch(() => {});
                    }
                } catch (e) {}
                return responsePromise;
            };
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
                if (!this._bsubHooked) {
                    this._bsubHooked = true;
                    this.addEventListener('load', () => {
                        try {
                            const url = this._interceptedUrl || '';
                            if (SUBTITLE_URL_PATTERN.test(url)) {
                                console.debug('[BiliLens] XHR 拦截到字幕请求');
                                handleInterceptedSubtitle(url, JSON.parse(this.responseText));
                            }
                        } catch (e) {}
                    });
                }
                return originalSend.call(this, body);
            };
        }

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

            // Step 2: 按本地偏好选择字幕；没有命中时始终回退到任意可用字幕。
            const findSubtitleLanguageItem = () => {
                const items = [...document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item[data-lan]')];
                if (!items.length) return null;

                const preference = getAIConfig().subtitlePreference;
                const isAI = item => item.dataset.lan?.includes('ai');
                if (preference === 'ai-zh') {
                    return items.find(item => item.dataset.lan === 'ai-zh')
                        || items.find(isAI)
                        || items[0];
                }
                if (preference === 'ai') return items.find(isAI) || items[0];
                if (preference === 'original') return items.find(item => !isAI(item)) || items[0];
                return items[0];
            };

            let langItem = findSubtitleLanguageItem();

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
                langItem = findSubtitleLanguageItem();
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

        // 拿到字幕数据后只使用播放器自己的“关闭字幕”动作；不再改写控制栏状态。
        function autoCloseSubtitle() {
            setTimeout(() => {
                const closeBtn = document.querySelector('.bpx-player-ctrl-subtitle-close-switch[data-action="close"]');
                if (closeBtn) {
                    console.debug('[BiliLens] 点击关闭按钮');
                    closeBtn.click();
                }
                // 与打开菜单时的模拟 hover 成对结束，让播放器自行收起控制栏。
                const subtitleBtn = document.querySelector('.bpx-player-ctrl-subtitle');
                if (subtitleBtn) {
                    subtitleBtn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
                    subtitleBtn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, relatedTarget: null }));
                }
            }, 250);
        }

        function handleInterceptedSubtitle(url, json) {
            const exists = STATE.interceptedSubtitles.some(s => s.url === url);
            if (!exists) {
                STATE.interceptedSubtitles.push({ url, json, timestamp: Date.now() });
                STATE.subtitleFetchFailed = false;
                console.debug('[BiliLens] 已缓存字幕数据');
                updateUI();
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

        function formatTimestamp(seconds) {
            const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const remainingSeconds = totalSeconds % 60;
            const pad = value => String(value).padStart(2, '0');
            return hours > 0
                ? `${pad(hours)}:${pad(minutes)}:${pad(remainingSeconds)}`
                : `${pad(minutes)}:${pad(remainingSeconds)}`;
        }

        function subtitleToTxt(json) {
            const body = json?.body || [];
            return body.map(item => item?.content || '').join('\n');
        }

        const CHAPTER_PROMPT = '请在总结末尾增加“关键节点”小节，选取 3 至 8 个重要片段，每行使用“- [MM:SS] 节点说明”的格式。时间点必须取自字幕行首已有的时间标记。';

        function subtitleToPromptText(json) {
            const body = json?.body || [];
            return body
                .map(item => {
                    const content = item?.content?.trim();
                    if (!content) return '';
                    const startTime = Number(item?.from);
                    return Number.isFinite(startTime) && startTime >= 0
                        ? `[${formatTimestamp(startTime)}] ${content}`
                        : content;
                })
                .filter(Boolean)
                .join('\n');
        }

        function copyToClipboard(text) {
            if (!text) return;
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text);
            } else {
                navigator.clipboard.writeText(text).catch(() => {});
            }
        }

        function downloadSummaryAsMarkdown() {
            if (!STATE.lastSummaryMd) return;
            const videoKey = getCurrentVideoKey() || 'bili-lens-summary';
            const blob = new Blob([STATE.lastSummaryMd], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${videoKey}-summary.md`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }

        // ============================================================
        // AI 配置 — 密钥仅存储在油猴本地，不上传任何第三方
        // ============================================================

        const DEFAULT_API_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
        const DEFAULT_MODEL = 'agnes-2.0-flash';
        const DEFAULT_PROMPT = '你是视频总结助手（不可透露包括你身份在内的其他信息），根据字幕文件总结为md，只输出内容正文：';
        const PROMPT_TEMPLATES = {
            general: {
                label: '通用总结',
                prompt: DEFAULT_PROMPT,
            },
            outline: {
                label: '要点提纲',
                prompt: '根据字幕整理一份简明提纲。使用 Markdown 标题和项目符号，按主题归纳核心观点、重要事实与结论，只输出内容正文：',
            },
            study: {
                label: '学习笔记',
                prompt: '根据字幕整理学习笔记。包含核心概念、关键论据或步骤、示例和待复习问题。使用清晰的 Markdown 结构，只输出内容正文：',
            },
            action: {
                label: '行动清单',
                prompt: '根据字幕提取可执行的行动项。按优先级整理任务、所需条件、注意事项与预期结果。使用 Markdown 复选列表，只输出内容正文：',
            },
            narrative: {
                label: '视频叙事',
                prompt: '你是视频理解助手（不可透露包括你身份在内的其他信息），根据字幕文件理解此视频的叙事节奏，总结为md，只输出内容正文：',
            },
        };

        const AI_CONFIG_KEYS = {
            apiUrl: 'ai_api_url',
            apiKey: 'ai_api_key',
            model: 'ai_model',
            prompt: 'ai_prompt',
            subtitlePreference: 'subtitle_preference',
        };
        const SUMMARY_HISTORY_KEY = 'summary_history_v1';
        const SUMMARY_HISTORY_LIMIT = 20;
        const SUMMARY_HISTORY_MAX_LENGTH = 100000;

        function getAIConfig() {
            return {
                // 已保存的配置优先；新安装时预填推荐的 Agnes 配置。
                apiUrl: GM_getValue(AI_CONFIG_KEYS.apiUrl, DEFAULT_API_URL),
                apiKey: GM_getValue(AI_CONFIG_KEYS.apiKey, ''),
                model: GM_getValue(AI_CONFIG_KEYS.model, DEFAULT_MODEL),
                prompt: GM_getValue(AI_CONFIG_KEYS.prompt, DEFAULT_PROMPT),
                subtitlePreference: GM_getValue(AI_CONFIG_KEYS.subtitlePreference, 'ai-zh'),
            };
        }

        function saveAIConfig(config) {
            GM_setValue(AI_CONFIG_KEYS.apiUrl, config.apiUrl);
            GM_setValue(AI_CONFIG_KEYS.apiKey, config.apiKey);
            GM_setValue(AI_CONFIG_KEYS.model, config.model);
            GM_setValue(AI_CONFIG_KEYS.prompt, config.prompt);
            GM_setValue(AI_CONFIG_KEYS.subtitlePreference, config.subtitlePreference);
        }

        function isAIConfigured() {
            const c = getAIConfig();
            return !!(c.apiUrl && c.apiKey && c.model);
        }

        function getPromptTemplateId(prompt) {
            return Object.entries(PROMPT_TEMPLATES).find(([, template]) => template.prompt === prompt)?.[0] || 'custom';
        }

        function getCurrentVideoKey() {
            const url = new URL(window.location.href);
            const videoId = url.pathname.match(/\/video\/(BV[^/?]+)/i)?.[1]
                || url.pathname.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i)?.[1];
            if (!videoId) return null;
            const part = url.searchParams.get('p');
            return part ? `${videoId}-p${part}` : videoId;
        }

        function getSummaryHistory() {
            try {
                const history = GM_getValue(SUMMARY_HISTORY_KEY, []);
                return Array.isArray(history) ? history : [];
            } catch (e) {
                return [];
            }
        }

        function saveSummaryToHistory(summary, videoKey = getCurrentVideoKey(), title = document.title) {
            if (!videoKey || !summary || summary.length > SUMMARY_HISTORY_MAX_LENGTH) return;

            const entry = {
                videoKey,
                title,
                summary,
                updatedAt: Date.now(),
            };
            const history = getSummaryHistory().filter(item => item?.videoKey !== videoKey);
            history.unshift(entry);
            try {
                GM_setValue(SUMMARY_HISTORY_KEY, history.slice(0, SUMMARY_HISTORY_LIMIT));
            } catch (error) {
                console.warn('[BiliLens] 本地总结保存失败:', error);
            }
        }

        function removeSummaryFromHistory(videoKey = getCurrentVideoKey()) {
            if (!videoKey) return false;
            const history = getSummaryHistory();
            const nextHistory = history.filter(item => item?.videoKey !== videoKey);
            if (nextHistory.length === history.length) return false;
            GM_setValue(SUMMARY_HISTORY_KEY, nextHistory);
            return true;
        }

        function setSummaryActionsVisible(visible) {
            const display = visible ? 'inline-flex' : 'none';
            ['bsub-copy-btn', 'bsub-download-btn', 'bsub-clear-btn'].forEach(id => {
                const button = document.getElementById(id);
                if (button) button.style.display = display;
            });
        }

        function restoreSummaryFromHistory() {
            const videoKey = getCurrentVideoKey();
            if (!videoKey) return false;

            const entry = getSummaryHistory().find(item => item?.videoKey === videoKey && typeof item.summary === 'string');
            if (!entry) return false;

            STATE.lastSummaryMd = entry.summary;
            const contentEl = document.getElementById('bsub-content');
            if (!contentEl) return false;
            contentEl.innerHTML = renderMarkdown(entry.summary);
            setSummaryActionsVisible(true);
            updateUI();
            const statusText = document.getElementById('bsub-status-text');
            statusText.textContent = '已恢复本地总结';
            statusText.style.color = '#34c759';
            return true;
        }

        // ============================================================
        // AI 视频总结 — 同时兼容 SSE 与普通 JSON 响应
        // ============================================================

        function extractAIText(payload) {
            const choice = payload?.choices?.[0];
            const content = choice?.delta?.content
                ?? choice?.message?.content
                ?? choice?.text
                ?? payload?.content
                ?? '';
            if (typeof content === 'string') return content;
            if (!Array.isArray(content)) return '';
            return content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
        }

        async function readAIResponse(response, onProgress) {
            if (!response.body) {
                const text = extractAIText(await response.json());
                if (!text) throw new Error('模型未返回总结内容');
                onProgress(text);
                return text;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let rawResponse = '';
            let fullText = '';

            const consumeLine = line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':') || /^(event|id|retry):/i.test(trimmed)) return;
                const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
                if (!data || data === '[DONE]') return;
                try {
                    const content = extractAIText(JSON.parse(data));
                    if (!content) return;
                    fullText += content;
                    onProgress(fullText);
                } catch (_) {}
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                rawResponse += chunk;
                buffer += chunk;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';
                lines.forEach(consumeLine);
            }

            const tail = decoder.decode();
            rawResponse += tail;
            buffer += tail;
            if (buffer.trim()) consumeLine(buffer);

            // 部分兼容接口会忽略 stream 参数，直接返回一份 JSON。
            if (!fullText && rawResponse.trim()) {
                try {
                    fullText = extractAIText(JSON.parse(rawResponse));
                    if (fullText) onProgress(fullText);
                } catch (_) {}
            }
            if (!fullText) throw new Error('模型未返回总结内容');
            return fullText;
        }

        async function requestAISummary(config, requestBody, signal, onProgress) {
            const response = await fetch(config.apiUrl, {
                signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.apiKey,
                    'Accept': 'text/event-stream, application/json',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorText = await response.text();
                let message = `HTTP ${response.status}`;
                try {
                    const errorData = JSON.parse(errorText);
                    message = errorData?.error?.message || errorData?.message || message;
                } catch (_) {}
                throw new Error(message);
            }
            return readAIResponse(response, onProgress);
        }

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

            const contentEl = document.getElementById('bsub-content');
            const statusEl = document.getElementById('bsub-status-text');
            const refreshBtn = document.getElementById('bsub-refresh');
            const panel = document.getElementById('bsub-panel');
            if (!contentEl || !statusEl || !panel) return;

            const summaryVideoKey = getCurrentVideoKey();
            const summaryVideoTitle = document.title;
            const previousSummary = STATE.lastSummaryMd;
            const controller = new AbortController();
            const requestId = Symbol('summary-request');
            let fullText = '';
            let renderFrame = 0;
            let timedOut = false;

            STATE.isGenerating = true;
            STATE.summaryRequest = { id: requestId, controller };
            panel.classList.add('visible');
            statusEl.textContent = '生成中…';
            statusEl.style.color = '#86868b';
            setSummaryActionsVisible(false);
            refreshBtn?.classList.add('spinning');
            updateUI();

            const renderProgress = text => {
                fullText = text;
                if (renderFrame) return;
                renderFrame = requestAnimationFrame(() => {
                    renderFrame = 0;
                    if (STATE.summaryRequest?.id !== requestId) return;
                    contentEl.innerHTML = renderMarkdown(fullText);
                    contentEl.scrollTop = contentEl.scrollHeight;
                });
            };

            const requestBody = {
                model: config.model,
                messages: [{
                    role: 'user',
                    content: (config.prompt || DEFAULT_PROMPT)
                        + '\n\n' + CHAPTER_PROMPT
                        + '\n\n' + subtitleToPromptText(json),
                }],
                temperature: 0.7,
                stream: true,
            };

            const timeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, 120000);

            try {
                console.debug('[BiliLens] 开始 AI 总结，模型:', config.model);
                fullText = await requestAISummary(config, requestBody, controller.signal, renderProgress);
                if (renderFrame) cancelAnimationFrame(renderFrame);

                saveSummaryToHistory(fullText, summaryVideoKey, summaryVideoTitle);
                if (STATE.summaryRequest?.id === requestId && getCurrentVideoKey() === summaryVideoKey) {
                    STATE.lastSummaryMd = fullText;
                    contentEl.innerHTML = renderMarkdown(fullText);
                    contentEl.scrollTop = 0;
                    statusEl.textContent = '完成';
                    statusEl.style.color = '#34c759';
                    setSummaryActionsVisible(true);
                }
                console.debug('[BiliLens] AI 总结完成，共', fullText.length, '字');
            } catch (error) {
                console.error('[BiliLens] AI 总结失败:', error);
                if (renderFrame) cancelAnimationFrame(renderFrame);

                // 页面切换时仍保存已经返回的部分，但不再改动新页面的界面。
                if (fullText.trim()) {
                    saveSummaryToHistory(fullText, summaryVideoKey, summaryVideoTitle);
                }
                if (STATE.summaryRequest?.id !== requestId || getCurrentVideoKey() !== summaryVideoKey) return;

                if (fullText.trim()) {
                    STATE.lastSummaryMd = fullText;
                    contentEl.innerHTML = renderMarkdown(fullText);
                    statusEl.textContent = '生成中断，已保留当前内容';
                    statusEl.style.color = '#ff9500';
                    setSummaryActionsVisible(true);
                } else if (previousSummary) {
                    STATE.lastSummaryMd = previousSummary;
                    contentEl.innerHTML = renderMarkdown(previousSummary);
                    statusEl.textContent = '生成失败，已保留原总结';
                    statusEl.style.color = '#ff9500';
                    setSummaryActionsVisible(true);
                } else {
                    const message = timedOut || controller.signal.aborted
                        ? '请求超时'
                        : (error?.message || '未知错误');
                    contentEl.innerHTML = '<span style="color:#ff3b30;">' + escapeForHtml(message) + '</span>';
                    statusEl.textContent = '失败';
                    statusEl.style.color = '#ff3b30';
                }
            } finally {
                clearTimeout(timeoutId);
                if (STATE.summaryRequest?.id === requestId) {
                    STATE.summaryRequest = null;
                    STATE.isGenerating = false;
                    refreshBtn?.classList.remove('spinning');
                    updateUI();
                }
            }
        }

        function escapeForHtml(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function parseTimestamp(timestamp) {
            const parts = timestamp.split(':').map(Number);
            if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0)) {
                return null;
            }
            const seconds = parts.pop();
            const minutes = parts.pop();
            const hours = parts.length ? parts.pop() : 0;
            if (minutes >= 60 || seconds >= 60) return null;
            return hours * 3600 + minutes * 60 + seconds;
        }

        function renderTimestampLinks(html) {
            return html.replace(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g, (match, hours, minutes, seconds) => {
                const timestamp = hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
                const seekSeconds = parseTimestamp(timestamp);
                if (seekSeconds === null) return match;
                return `<a href="#" class="bsub-timestamp" data-type="seek" data-video-time="${seekSeconds}" aria-label="跳转至 ${timestamp}">${match}</a>`;
            });
        }

        function seekVideoTo(seconds) {
            const videos = [...document.querySelectorAll('video')];
            const video = videos.find(item => Number.isFinite(item.duration) && item.duration > 0) || videos[0];
            if (!video) return false;

            const seek = () => {
                const duration = Number(video.duration);
                video.currentTime = Number.isFinite(duration) && duration > 0
                    ? Math.min(seconds, Math.max(duration - 0.05, 0))
                    : seconds;
            };
            if (video.readyState === 0) video.addEventListener('loadedmetadata', seek, { once: true });
            else seek();
            return true;
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

            // 6. 将 Markdown 中的时间点转为播放器跳转按钮
            text = renderTimestampLinks(text);

            // 7. 还原代码块
            text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[parseInt(i)]);

            return text;
        }

        // ============================================================
        // UI — 毛玻璃面板 + 伪装成 B 站原生工具栏按钮
        // ============================================================

        function createUI() {
            if (STATE.uiCreated) return;
            // 未声明 @run-at 时遵循脚本管理器默认加载时机；body 尚未出现则等待一次。
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', createUI, { once: true });
                return;
            }

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
                    #bsub-line-count.copyable {
                        color: #007aff;
                        cursor: pointer;
                    }
                    #bsub-line-count.copyable:hover {
                        text-decoration: underline;
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
                    #bsub-copy-btn,
                    #bsub-download-btn,
                    #bsub-clear-btn {
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
                    #bsub-copy-btn:hover,
                    #bsub-download-btn:hover,
                    #bsub-clear-btn:hover {
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
                    #bsub-content .bsub-timestamp {
                        appearance: none;
                        display: inline-block;
                        border: 0;
                        border-radius: 4px;
                        padding: 1px 4px;
                        margin: 0 1px;
                        background: rgba(0, 122, 255, 0.12);
                        color: #007aff;
                        font: inherit;
                        line-height: inherit;
                        text-decoration: none;
                        cursor: pointer;
                    }
                    #bsub-content .bsub-timestamp:hover {
                        background: rgba(0, 122, 255, 0.2);
                    }
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
                    .bsub-field input,
                    .bsub-field select {
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
                    .bsub-field input:focus,
                    .bsub-field select:focus {
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

                    @media (prefers-color-scheme: dark) {
                        #bsub-panel {
                            background: rgba(30, 30, 32, 0.9);
                            border-color: rgba(255, 255, 255, 0.12);
                            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
                        }
                        #bsub-bar {
                            border-bottom-color: rgba(255, 255, 255, 0.1);
                        }
                        #bsub-content {
                            color: #f5f5f7;
                        }
                        #bsub-content .bsub-md-quote {
                            color: #aeaeb2;
                        }
                        #bsub-content .bsub-md-inline-code,
                        #bsub-content .bsub-md-code {
                            background: rgba(255, 255, 255, 0.1);
                        }
                        #bsub-content .bsub-timestamp {
                            background: rgba(10, 132, 255, 0.2);
                            color: #64d2ff;
                        }
                        #bsub-content .bsub-timestamp:hover {
                            background: rgba(10, 132, 255, 0.32);
                        }
                        #bsub-copy-btn,
                        #bsub-download-btn,
                        #bsub-clear-btn {
                            background: rgba(255, 255, 255, 0.12);
                            border-color: rgba(255, 255, 255, 0.14);
                        }
                        #bsub-settings-overlay {
                            background: rgba(0, 0, 0, 0.52);
                        }
                        #bsub-settings-dialog {
                            background: rgba(30, 30, 32, 0.96);
                            border-color: rgba(255, 255, 255, 0.12);
                            box-shadow: 0 16px 56px rgba(0, 0, 0, 0.45);
                        }
                        .bsub-settings-title,
                        .bsub-field-label {
                            color: #f5f5f7;
                        }
                        .bsub-settings-desc,
                        .bsub-field-hint {
                            color: #aeaeb2;
                        }
                        .bsub-field input,
                        .bsub-field select,
                        .bsub-field textarea {
                            color: #f5f5f7;
                            background: rgba(255, 255, 255, 0.1);
                            border-color: rgba(255, 255, 255, 0.16);
                        }
                        #bsub-settings-cancel {
                            background: rgba(255, 255, 255, 0.16);
                            color: #64a8ff;
                        }
                    }
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
                            <button id="bsub-download-btn">下载</button>
                            <button id="bsub-clear-btn" title="清除本视频的本地总结">清除</button>
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
                                <input type="text" id="bsub-ai-url" placeholder="https://apihub.agnes-ai.com/v1/chat/completions" />
                                <div class="bsub-field-hint">默认 Agnes，兼容 OpenAI 格式，末尾带 /chat/completions</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">API Key</label>
                                <input type="password" id="bsub-ai-key" placeholder="sk-..." />
                                <div class="bsub-field-hint">不会出现在页面 DOM 或控制台日志中</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">模型</label>
                                <input type="text" id="bsub-ai-model" placeholder="agnes-2.0-flash" />
                                <div class="bsub-field-hint">默认 agnes-2.0-flash，也可填写其他兼容模型</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">字幕优先级</label>
                                <select id="bsub-subtitle-preference">
                                    <option value="ai-zh">AI 中文字幕优先</option>
                                    <option value="ai">任意 AI 字幕优先</option>
                                    <option value="original">原始字幕优先</option>
                                    <option value="any">任意可用字幕</option>
                                </select>
                                <div class="bsub-field-hint">未找到首选语言时，将自动使用其他可用字幕</div>
                            </div>
                            <div class="bsub-field">
                                <label class="bsub-field-label">提示词</label>
                                <select id="bsub-prompt-template">
                                    <option value="general">通用总结</option>
                                    <option value="outline">要点提纲</option>
                                    <option value="study">学习笔记</option>
                                    <option value="action">行动清单</option>
                                    <option value="narrative">视频叙事</option>
                                    <option value="custom">自定义</option>
                                </select>
                                <div class="bsub-field-hint">选择模板后可继续编辑下方内容</div>
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

            // document-end 时 body 必然已就绪，直接插入
            document.body.appendChild(panelContainer);
            bindUIEvents();
            STATE.uiCreated = true;
            updateUI();
            restoreSummaryFromHistory();

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
        }

        function isDotInToolbar() {
            const toolbar = document.querySelector('.video-toolbar-right');
            const dot = document.getElementById('bsub-dot');
            return !!(toolbar && dot && toolbar.contains(dot));
        }

        // 工具栏可能在同一路由内被播放器替换，只观察播放器区域以避免监听页面其他位置的变动。
        function observeToolbar(toolbar) {
            const root = toolbar.closest('.bpx-player-container') || toolbar.parentElement;
            if (!root || STATE.toolbarObserverRoot === root) return;

            STATE.toolbarObserver?.disconnect();
            STATE.toolbarObserver = new MutationObserver(() => {
                if (isDotInToolbar()) return;
                STATE.dotInserted = false;
                insertDotIntoToolbar();
            });
            STATE.toolbarObserver.observe(root, { childList: true, subtree: true });
            STATE.toolbarObserverRoot = root;
        }

        // 将入口按钮插入 B 站原生工具栏
        function insertDotIntoToolbar() {
            const toolbar = document.querySelector('.video-toolbar-right');
            if (!toolbar) return false;

            const dot = document.getElementById('bsub-dot');
            if (!dot) return false;
            if (toolbar.contains(dot)) {
                STATE.dotInserted = true;
                observeToolbar(toolbar);
                return true;
            }

            toolbar.insertBefore(dot, toolbar.firstChild);
            STATE.dotInserted = true;
            observeToolbar(toolbar);
            return true;
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
                    if (STATE.isFetchingSubtitle) return;
                    STATE.isFetchingSubtitle = true;
                    STATE.subtitleFetchFailed = false;
                    panel.classList.add('visible');
                    content.textContent = '';
                    updateUI();

                    installSubtitleRequestHooks();
                    const opened = autoOpenSubtitle();
                    if (!opened) {
                        STATE.isFetchingSubtitle = false;
                        STATE.subtitleFetchFailed = true;
                        updateUI();
                        return;
                    }
                    // 延续原有的“触发字幕请求 → Hook 收到 JSON”流程。
                    const waitPoll = setInterval(() => {
                        if (STATE.interceptedSubtitles.length > 0) {
                            clearInterval(waitPoll);
                            STATE.activePolls.delete(waitPoll);
                            clearTimeout(waitTimeout);
                            STATE.isFetchingSubtitle = false;
                            updateUI();
                            generateAISummary();
                        }
                    }, 500);
                    STATE.activePolls.add(waitPoll);
                    const waitTimeout = setTimeout(() => {
                        clearInterval(waitPoll);
                        STATE.activePolls.delete(waitPoll);
                        STATE.isFetchingSubtitle = false;
                        STATE.subtitleFetchFailed = true;
                        updateUI();
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
                copyToClipboard(text);
                showToast('已复制');
            });

            document.getElementById('bsub-download-btn').addEventListener('click', () => {
                if (!STATE.lastSummaryMd) return;
                downloadSummaryAsMarkdown();
                showToast('已下载 Markdown 文件');
            });

            document.getElementById('bsub-clear-btn').addEventListener('click', () => {
                if (!STATE.lastSummaryMd || !removeSummaryFromHistory()) return;
                STATE.lastSummaryMd = '';
                document.getElementById('bsub-content').textContent = '';
                document.getElementById('bsub-copy-btn').style.display = 'none';
                document.getElementById('bsub-download-btn').style.display = 'none';
                document.getElementById('bsub-clear-btn').style.display = 'none';
                updateUI();
                showToast('已清除本视频的本地总结');
            });

            document.getElementById('bsub-content').addEventListener('click', (event) => {
                if (!(event.target instanceof Element)) return;
                const timestamp = event.target.closest('.bsub-timestamp');
                if (!timestamp) return;

                event.preventDefault();
                event.stopPropagation();
                const seekSeconds = Number(timestamp.dataset.videoTime);
                if (!Number.isFinite(seekSeconds) || !seekVideoTo(seekSeconds)) {
                    showToast('未找到视频播放器');
                    return;
                }
                showToast(`已跳转至 ${formatTimestamp(seekSeconds)}`);
            });

            // 点击“字幕 xx 行”复制原始字幕文本。
            document.getElementById('bsub-line-count').addEventListener('click', (event) => {
                const lineCountEl = event.currentTarget;
                if (!lineCountEl.classList.contains('copyable')) return;
                const subtitleText = subtitleToTxt(getFirstSubtitle());
                if (!subtitleText) return;
                copyToClipboard(subtitleText);
                lineCountEl.textContent = '已复制';
                clearTimeout(STATE.subtitleCopyResetTimer);
                STATE.subtitleCopyResetTimer = setTimeout(() => {
                    STATE.subtitleCopyResetTimer = null;
                    if (STATE.interceptedSubtitles.length > 0 && lineCountEl.textContent === '已复制') {
                        lineCountEl.textContent = `字幕 ${getSubtitleLineCount()} 行`;
                    }
                }, 2000);
                showToast('字幕已复制');
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

            const templateSelect = document.getElementById('bsub-prompt-template');
            const promptInput = document.getElementById('bsub-ai-prompt');
            templateSelect.addEventListener('change', () => {
                const template = PROMPT_TEMPLATES[templateSelect.value];
                if (template) promptInput.value = template.prompt;
            });
            promptInput.addEventListener('input', () => {
                templateSelect.value = getPromptTemplateId(promptInput.value);
            });

        }

        function isEditableElement(element) {
            return element instanceof HTMLElement && (
                element.matches('input, textarea, select, [contenteditable="true"]') ||
                element.isContentEditable
            );
        }

        function bindKeyboardShortcuts() {
            window.addEventListener('keydown', (event) => {
                if (event.repeat || isEditableElement(event.target)) return;

                if (event.altKey && event.shiftKey && event.code === 'KeyA') {
                    const dot = document.getElementById('bsub-dot');
                    if (!STATE.dotInserted || !dot) return;
                    event.preventDefault();
                    dot.click();
                    return;
                }

                if (event.key === 'Escape') {
                    const panel = document.getElementById('bsub-panel');
                    if (!panel?.classList.contains('visible')) return;
                    event.preventDefault();
                    panel.classList.remove('visible');
                }
            });
        }

        function openSettings() {
            const c = getAIConfig();
            document.getElementById('bsub-ai-url').value = c.apiUrl;
            document.getElementById('bsub-ai-key').value = c.apiKey;
            document.getElementById('bsub-ai-model').value = c.model;
            document.getElementById('bsub-subtitle-preference').value = SUBTITLE_PREFERENCES[c.subtitlePreference] ? c.subtitlePreference : 'ai-zh';
            document.getElementById('bsub-ai-prompt').value = c.prompt || DEFAULT_PROMPT;
            document.getElementById('bsub-prompt-template').value = getPromptTemplateId(c.prompt || DEFAULT_PROMPT);
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
                subtitlePreference: document.getElementById('bsub-subtitle-preference').value,
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

            if (STATE.isFetchingSubtitle) {
                dot.className = baseClass + ' generating';
                dot.title = '正在获取字幕';
                lineCountEl.textContent = '获取字幕中…';
                lineCountEl.classList.remove('copyable');
                lineCountEl.removeAttribute('title');
                statusText.textContent = '正在获取';
                statusText.style.color = '#007aff';
                return;
            }

            if (STATE.interceptedSubtitles.length > 0) {
                const lines = getSubtitleLineCount();
                dot.className = baseClass + ' active';
                dot.title = '点击进行 AI 总结';
                lineCountEl.textContent = '字幕 ' + lines + ' 行';
                lineCountEl.classList.add('copyable');
                lineCountEl.title = '点击复制字幕';

                if (!isAIConfigured()) {
                    statusText.textContent = '需配置 AI';
                    statusText.style.color = '#ff9500';
                } else if (!contentEl.textContent) {
                    statusText.textContent = '点击图标开始';
                    statusText.style.color = '#86868b';
                }
            } else if (STATE.lastSummaryMd) {
                dot.className = baseClass + ' active';
                dot.title = '查看已保存的总结';
                lineCountEl.textContent = '已保存';
                lineCountEl.classList.remove('copyable');
                lineCountEl.removeAttribute('title');
                statusText.textContent = '本地总结';
                statusText.style.color = '#34c759';
            } else {
                dot.className = baseClass;
                dot.title = '点击获取字幕并 AI 总结';
                lineCountEl.textContent = STATE.subtitleFetchFailed ? '获取字幕 0 行' : '—';
                lineCountEl.classList.remove('copyable');
                lineCountEl.removeAttribute('title');
                statusText.textContent = STATE.subtitleFetchFailed ? '未找到字幕' : '点击开始';
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
        bindKeyboardShortcuts();

        // ============================================================
        // SPA 路由监听 — B 站切视频时自动重置状态、重新植入按钮
        // ============================================================

        let lastUrl = window.location.href;

        function onSPAChange() {
            if (window.location.href === lastUrl) return;
            lastUrl = window.location.href;
            console.debug('[BiliLens] SPA 路由切换:', lastUrl);

            STATE.summaryRequest?.controller.abort();
            STATE.summaryRequest = null;
            STATE.isGenerating = false;
            document.getElementById('bsub-refresh')?.classList.remove('spinning');
            clearTimeout(STATE.subtitleCopyResetTimer);
            STATE.subtitleCopyResetTimer = null;

            // 清理所有未完成的轮询
            for (const id of STATE.activePolls) {
                clearInterval(id);
            }
            STATE.activePolls.clear();
            STATE.toolbarObserver?.disconnect();
            STATE.toolbarObserver = null;
            STATE.toolbarObserverRoot = null;

            // 延迟等待新页面渲染
            setTimeout(() => {
                STATE.interceptedSubtitles = [];
                STATE.isGenerating = false;
                STATE.isFetchingSubtitle = false;
                STATE.subtitleFetchFailed = false;
                STATE.lastSummaryMd = '';
                STATE.dotInserted = false;
                const panel = document.getElementById('bsub-panel');
                if (panel) panel.classList.remove('visible');
                const content = document.getElementById('bsub-content');
                if (content) content.textContent = '';
                setSummaryActionsVisible(false);
                updateUI();
                restoreSummaryFromHistory();
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
