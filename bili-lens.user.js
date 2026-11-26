    // ==UserScript==
    // @name         BiliLens
    // @namespace    https://github.com/FrRay/BiliLens
    // @version      5.2.1
    // @description  为 B 站视频提供 AI 辅助的摘要生成功能：自动获取字幕，并通过兼容 OpenAI 接口的模型流式输出视频总结。
    // @author       FrRay
    // @match        https://www.bilibili.com/video/*
    // @match        https://www.bilibili.com/bangumi/play/*
    // @match        https://www.bilibili.com/list/watchlater/*
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
            subtitleWaitTimeout: null,
            // 面板视图：summary 为 AI 总结，lines 为逐句字幕
            panelView: 'summary',
            subtitleLines: [],
            subtitleActiveIndex: -1,
            subtitleFollow: true,
            subtitleTimeHandler: null,
            // SPA 切换时清理轮询的句柄
            activePolls: new Set(),
        };

        // ============================================================
        // 字幕拦截 — 静默捕获 B 站 AI 字幕数据
        // ============================================================

        const SUBTITLE_URL_PATTERN = /aisubtitle\.hdslb\.com/i;
        let removeSubtitleRequestHooks = null;
        const SUBTITLE_PREFERENCES = {
            'ai-zh': 'AI 中文字幕优先',
            ai: '任意 AI 字幕优先',
            original: '原始字幕优先',
            any: '任意可用字幕',
        };

        // 只在本次字幕获取期间拦截，结束后恢复页面原有请求方法。
        function installSubtitleRequestHooks() {
            if (removeSubtitleRequestHooks) return;
            let active = true;
            const subtitleRequests = new Map();

            const originalFetch = window.fetch;
            const wrappedFetch = function (...args) {
                const responsePromise = originalFetch.apply(this, args);
                try {
                    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                    if (active && SUBTITLE_URL_PATTERN.test(url)) {
                        responsePromise.then(response => {
                            if (active) return response.clone().json();
                        }).then(json => {
                            if (active && json) handleInterceptedSubtitle(url, json);
                        }).catch(() => {});
                    }
                } catch (e) {}
                return responsePromise;
            };
            window.fetch = wrappedFetch;
            try {
                Object.defineProperty(wrappedFetch, 'toString', { value: () => 'function fetch() { [native code] }' });
            } catch (e) {}

            const originalOpen = XMLHttpRequest.prototype.open;
            const wrappedOpen = function (method, url, ...rest) {
                const result = originalOpen.call(this, method, url, ...rest);
                const previous = subtitleRequests.get(this);
                if (previous) {
                    this.removeEventListener('load', previous);
                    subtitleRequests.delete(this);
                }
                const requestUrl = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');
                if (active && SUBTITLE_URL_PATTERN.test(requestUrl)) {
                    const onLoad = () => {
                        subtitleRequests.delete(this);
                        try {
                            const json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                            if (active && json) handleInterceptedSubtitle(requestUrl, json);
                        } catch (e) {}
                    };
                    subtitleRequests.set(this, onLoad);
                    this.addEventListener('load', onLoad, { once: true });
                }
                return result;
            };
            XMLHttpRequest.prototype.open = wrappedOpen;

            removeSubtitleRequestHooks = () => {
                active = false;
                if (window.fetch === wrappedFetch) window.fetch = originalFetch;
                if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
                for (const [request, listener] of subtitleRequests) request.removeEventListener('load', listener);
                subtitleRequests.clear();
                removeSubtitleRequestHooks = null;
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
            subtitleBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
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

        function finishSubtitleHover() {
            const subtitleBtn = document.querySelector('.bpx-player-ctrl-subtitle');
            if (!subtitleBtn) return;
            subtitleBtn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
            subtitleBtn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }));
            const player = subtitleBtn.closest('.bpx-player-container');
            if (player && !player.matches(':hover')) {
                player.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }));
            }
        }

        // 使用播放器自己的“关闭字幕”动作，然后结束模拟的鼠标移入。
        function autoCloseSubtitle() {
            const subtitleBtn = document.querySelector('.bpx-player-ctrl-subtitle');
            const pageUrl = window.location.href;
            setTimeout(() => {
                if (window.location.href !== pageUrl || !subtitleBtn?.isConnected || subtitleBtn !== document.querySelector('.bpx-player-ctrl-subtitle')) return;
                const closeBtn = document.querySelector('.bpx-player-ctrl-subtitle-close-switch[data-action="close"]');
                if (closeBtn) {
                    console.debug('[BiliLens] 点击关闭按钮');
                    closeBtn.click();
                }
                finishSubtitleHover();
            }, 250);
        }

        function handleInterceptedSubtitle(url, json) {
            const exists = STATE.interceptedSubtitles.some(s => s.url === url);
            if (!exists) {
                removeSubtitleRequestHooks?.();
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
        const DEFAULT_MODEL = 'agnes-2.5-flash';
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
        const PANEL_WIDTH_KEY = 'panel_width';
        const PANEL_HEIGHT_KEY = 'panel_height';
        const PANEL_POSITION_KEY = 'panel_position';
        const SUBTITLE_FOLLOW_KEY = 'subtitle_follow';

        function restorePanelPosition(panel) {
            const position = GM_getValue(PANEL_POSITION_KEY, null);
            if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
            panel.style.left = Math.max(0, Math.min(position.left, window.innerWidth - panel.offsetWidth)) + 'px';
            panel.style.top = Math.max(0, Math.min(position.top, window.innerHeight - panel.offsetHeight)) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        function showSummaryPanel(panel) {
            panel.classList.add('visible');
            restorePanelPosition(panel);
        }

        function savePanelPosition(panel) {
            const rect = panel.getBoundingClientRect();
            GM_setValue(PANEL_POSITION_KEY, { left: rect.left, top: rect.top });
        }

        function getAIConfig() {
            const savedModel = GM_getValue(AI_CONFIG_KEYS.model, DEFAULT_MODEL);
            return {
                // 已保存的配置优先；新安装时预填推荐的 Agnes 配置。
                apiUrl: GM_getValue(AI_CONFIG_KEYS.apiUrl, DEFAULT_API_URL),
                apiKey: GM_getValue(AI_CONFIG_KEYS.apiKey, ''),
                // 兼容旧版本：2.0 已弃用时，自动迁移到当前默认模型。
                model: savedModel === 'agnes-2.0-flash' ? DEFAULT_MODEL : savedModel,
                prompt: getActivePromptText(),
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

        // ---- 提示词库 ----
        // 一条提示词 = 内置模板（可改写，可恢复默认）或用户自建条目，均可保存多条。
        const PROMPT_LIBRARY_KEY = 'prompt_library_v1';
        const PROMPT_CUSTOM_LIMIT = 30;
        const PROMPT_NAME_MAX = 24;
        const PROMPT_TEXT_MAX = 4000;

        function createPromptId() {
            return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        }

        function normalizePromptName(value) {
            const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
            return text.slice(0, PROMPT_NAME_MAX);
        }

        function normalizePromptText(value) {
            return typeof value === 'string' ? value.trim().slice(0, PROMPT_TEXT_MAX) : '';
        }

        // 按文本反查内置模板，用于旧版本单条提示词的迁移。
        function getBuiltinPromptId(prompt) {
            const text = normalizePromptText(prompt);
            if (!text) return '';
            return Object.keys(PROMPT_TEMPLATES).find(id => PROMPT_TEMPLATES[id].prompt.trim() === text) || '';
        }

        function savePromptLibrary(library) {
            try {
                GM_setValue(PROMPT_LIBRARY_KEY, library);
            } catch (error) {
                console.warn('[BiliLens] 保存提示词库失败:', error);
            }
        }

        function getPromptLibrary() {
            const library = { overrides: {}, custom: [], active: '' };
            let raw = null;
            try {
                raw = GM_getValue(PROMPT_LIBRARY_KEY, null);
            } catch (error) {
                console.warn('[BiliLens] 读取提示词库失败:', error);
            }

            if (raw && typeof raw === 'object') {
                if (raw.overrides && typeof raw.overrides === 'object') {
                    Object.keys(PROMPT_TEMPLATES).forEach(id => {
                        const text = normalizePromptText(raw.overrides[id]);
                        if (text) library.overrides[id] = text;
                    });
                }
                if (Array.isArray(raw.custom)) {
                    raw.custom.forEach(item => {
                        if (!item || typeof item !== 'object') return;
                        const prompt = normalizePromptText(item.prompt);
                        if (!prompt) return;
                        library.custom.push({
                            id: typeof item.id === 'string' && item.id ? item.id : createPromptId(),
                            name: normalizePromptName(item.name) || `提示词 ${library.custom.length + 1}`,
                            prompt,
                        });
                    });
                }
                if (typeof raw.active === 'string') library.active = raw.active;
            } else {
                // 迁移：5.1.0 及更早版本只有一条 ai_prompt。
                const legacy = normalizePromptText(GM_getValue(AI_CONFIG_KEYS.prompt, DEFAULT_PROMPT));
                const builtinId = getBuiltinPromptId(legacy);
                if (builtinId) {
                    library.active = builtinId;
                } else if (legacy) {
                    const item = { id: createPromptId(), name: '我的提示词', prompt: legacy };
                    library.custom.push(item);
                    library.active = 'custom:' + item.id;
                } else {
                    library.active = 'general';
                }
                savePromptLibrary(library);
            }

            // 选中项被删除或数据损坏时回落到默认模板，避免出现空提示词。
            if (!resolvePromptEntry(library, library.active)) library.active = 'general';
            return library;
        }

        // key 为内置模板 id 或 'custom:<id>'；返回 null 表示该条目已不存在。
        function resolvePromptEntry(library, key) {
            if (!key || typeof key !== 'string') return null;
            if (key.indexOf('custom:') === 0) {
                const id = key.slice(7);
                const item = library.custom.find(row => row.id === id);
                if (!item) return null;
                return { key, kind: 'custom', id, name: item.name, prompt: item.prompt, adapted: false };
            }
            const template = PROMPT_TEMPLATES[key];
            if (!template) return null;
            const adapted = Object.prototype.hasOwnProperty.call(library.overrides, key);
            return {
                key,
                kind: 'builtin',
                id: key,
                name: template.label,
                prompt: adapted ? library.overrides[key] : template.prompt,
                adapted,
            };
        }

        // 当前生效的提示词：提示词库选中的条目优先，其次回落到 ai_prompt。
        function getActivePromptText() {
            const library = getPromptLibrary();
            const entry = resolvePromptEntry(library, library.active);
            if (entry) return entry.prompt;
            return normalizePromptText(GM_getValue(AI_CONFIG_KEYS.prompt, DEFAULT_PROMPT)) || DEFAULT_PROMPT;
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

        function historyVideoUrl(videoKey) {
            if (typeof videoKey !== 'string') return null;
            const match = videoKey.match(/^(BV[0-9a-z]+|ep\d+|ss\d+)(?:-p(\d+))?$/i);
            if (!match) return null;
            const path = /^BV/i.test(match[1]) ? '/video/' : '/bangumi/play/';
            return path + match[1] + (match[2] ? '?p=' + match[2] : '');
        }

        function setHistoryVisible(visible) {
            const panel = document.getElementById('bsub-panel');
            const list = document.getElementById('bsub-history');
            const button = document.getElementById('bsub-history-btn');
            if (!panel || !list || !button) return;
            panel.classList.toggle('bsub-show-history', visible);
            button.setAttribute('aria-expanded', String(visible));
            list.style.display = visible ? 'block' : 'none';
            if (!visible) return;

            list.style.top = document.getElementById('bsub-bar').offsetHeight + 'px';
            renderSummaryHistory();
        }

        // 历史条目支持单条删除与整表清空，删除当前视频的条目时同步清空面板。
        function renderSummaryHistory() {
            const list = document.getElementById('bsub-history');
            if (!list) return;
            list.replaceChildren();
            const entries = getSummaryHistory().slice(0, SUMMARY_HISTORY_LIMIT)
                .map(entry => ({ entry, url: historyVideoUrl(entry?.videoKey) }))
                .filter(item => item.url && typeof item.entry.summary === 'string');
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'bsub-history-empty';
                empty.textContent = '暂无本地总结';
                list.appendChild(empty);
                return;
            }

            const toolbar = document.createElement('div');
            toolbar.className = 'bsub-history-toolbar';
            const count = document.createElement('span');
            count.className = 'bsub-history-count';
            count.textContent = `共 ${entries.length} 条`;
            const clearAll = document.createElement('button');
            clearAll.type = 'button';
            clearAll.className = 'bsub-history-clear';
            clearAll.textContent = '清空全部';
            let armed = false;
            let armTimer = null;
            const disarm = () => {
                armed = false;
                clearTimeout(armTimer);
                armTimer = null;
                clearAll.classList.remove('armed');
                clearAll.textContent = '清空全部';
            };
            clearAll.addEventListener('click', () => {
                if (!armed) {
                    armed = true;
                    clearAll.classList.add('armed');
                    clearAll.textContent = '确认清空？';
                    armTimer = setTimeout(disarm, 3000);
                    return;
                }
                const currentKey = getCurrentVideoKey();
                const hadCurrent = !!currentKey && entries.some(item => item.entry.videoKey === currentKey);
                disarm();
                clearSummaryHistory();
                if (hadCurrent) clearCurrentSummary();
                renderSummaryHistory();
                showToast('已清空本地总结历史');
            });
            toolbar.append(count, clearAll);
            list.appendChild(toolbar);

            const fragment = document.createDocumentFragment();
            entries.forEach(({ entry, url }) => {
                const item = document.createElement('div');
                item.className = 'bsub-history-item';

                const link = document.createElement('a');
                link.className = 'bsub-history-link';
                link.href = url;
                const title = document.createElement('span');
                title.className = 'bsub-history-title';
                title.textContent = typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.videoKey;
                const date = document.createElement('span');
                date.className = 'bsub-history-date';
                const time = new Date(entry.updatedAt);
                date.textContent = Number.isFinite(time.getTime())
                    ? time.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : '';
                link.append(title, date);
                link.addEventListener('click', event => {
                    if (entry.videoKey !== getCurrentVideoKey() || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    setHistoryVisible(false);
                    if (!STATE.isGenerating) restoreSummaryFromHistory();
                });

                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'bsub-history-remove';
                remove.title = '删除这条总结';
                remove.setAttribute('aria-label', '删除这条总结');
                remove.textContent = '×';
                remove.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!removeSummaryFromHistory(entry.videoKey)) return;
                    if (entry.videoKey === getCurrentVideoKey()) clearCurrentSummary();
                    renderSummaryHistory();
                    showToast('已删除这条本地总结');
                });

                item.append(link, remove);
                fragment.appendChild(item);
            });
            list.appendChild(fragment);
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

        function clearSummaryHistory() {
            try {
                GM_setValue(SUMMARY_HISTORY_KEY, []);
            } catch (error) {
                console.warn('[BiliLens] 清空本地总结失败:', error);
            }
        }

        // 清空面板上的总结，并删除当前视频对应的历史条目。
        function clearCurrentSummary() {
            const videoKey = getCurrentVideoKey();
            if (videoKey) removeSummaryFromHistory(videoKey);
            STATE.lastSummaryMd = '';
            const contentEl = document.getElementById('bsub-content');
            if (contentEl) contentEl.textContent = '';
            setSummaryActionsVisible(false);
            updateUI();
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
            if (STATE.panelView === 'lines') setPanelView('summary');
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

        // 部分兼容接口会用 HTTP 200 返回错误体，这里把错误信息提取出来。
        function extractAIError(payload) {
            const error = payload?.error;
            if (error) {
                if (typeof error === 'string') return error;
                return error.message || error.msg || error.code || '未知错误';
            }
            if (!payload?.choices && payload?.code !== undefined && Number(payload.code) !== 0) {
                return payload.message || payload.msg || `错误码 ${payload.code}`;
            }
            return '';
        }

        async function readAIResponse(response, onProgress) {
            if (!response.body) {
                const payload = await response.json();
                const errorText = extractAIError(payload);
                if (errorText) throw new Error('模型服务返回错误：' + errorText);
                const text = extractAIText(payload);
                if (!text) throw new Error('模型未返回总结内容');
                onProgress(text);
                return text;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let rawResponse = '';
            let fullText = '';
            let streamError = '';

            const consumeLine = line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':') || /^(event|id|retry):/i.test(trimmed)) return;
                const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
                if (!data || data === '[DONE]') return;
                try {
                    const payload = JSON.parse(data);
                    const errorText = extractAIError(payload);
                    if (errorText) {
                        streamError = errorText;
                        return;
                    }
                    const content = extractAIText(payload);
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
                let payload = null;
                try {
                    payload = JSON.parse(rawResponse);
                } catch (_) {}
                if (payload) {
                    const errorText = extractAIError(payload);
                    if (errorText) throw new Error('模型服务返回错误：' + errorText);
                    fullText = extractAIText(payload);
                    if (fullText) onProgress(fullText);
                }
            }
            if (!fullText && streamError) throw new Error('模型服务返回错误：' + streamError);
            if (!fullText) throw new Error('模型未返回总结内容');
            return fullText;
        }

        // 允许省略协议头，并清掉粘贴时常见的引号、空白与结尾斜杠。
        function normalizeApiUrl(value) {
            let url = typeof value === 'string' ? value.trim() : '';
            if (!url) return '';
            url = url.replace(/^["'<`\s]+|["'>`\s]+$/g, '');
            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
            return url.replace(/\/+$/, '');
        }

        // 把 HTTP 状态码翻译成用户可执行的排查提示。
        function apiErrorMessage(status, serverMessage) {
            const message = typeof serverMessage === 'string' ? serverMessage.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
            const detail = message ? `（服务端返回：${message}）` : '';
            if (status === 401 || status === 403) {
                return `API Key 无效或无权限（HTTP ${status}），请检查设置里的 Key 是否与当前 API URL 配套${detail}`;
            }
            if (status === 404) {
                return `接口地址不存在（HTTP 404），请检查 API URL 是否完整，通常以 /chat/completions 结尾${detail}`;
            }
            if (status === 429) {
                return `请求过于频繁（HTTP 429），请稍后再试${detail}`;
            }
            if (status >= 500) {
                return `模型服务暂时不可用（HTTP ${status}），请稍后重试${detail}`;
            }
            return message ? `${message}（HTTP ${status}）` : `HTTP ${status}`;
        }

        async function requestAISummary(config, requestBody, signal, onProgress) {
            const apiUrl = normalizeApiUrl(config.apiUrl);
            if (!apiUrl) throw new Error('未配置 API URL');

            let response;
            try {
                response = await fetch(apiUrl, {
                    signal,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + config.apiKey,
                        'Accept': 'text/event-stream, application/json',
                    },
                    body: JSON.stringify(requestBody),
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                throw new Error('无法连接模型服务：请检查网络是否可用，或确认该接口允许来自 bilibili.com 的跨域请求（CORS）。原始错误：' + (error?.message || '网络错误'));
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                let serverMessage = '';
                try {
                    const errorData = JSON.parse(errorText);
                    serverMessage = errorData?.error?.message || errorData?.message || '';
                } catch (_) {
                    serverMessage = errorText;
                }
                throw new Error(apiErrorMessage(response.status, serverMessage));
            }
            return readAIResponse(response, onProgress);
        }

        // 字幕还没拦截到时的统一入口：自动展开字幕菜单、等待拦截，成功后接着生成总结。
        // 「恢复本地总结」「切换视频后重新生成」都走这里，否则只会得到一句“没有字幕数据”。
        function captureSubtitlesThenSummarize() {
            if (STATE.isGenerating || STATE.isFetchingSubtitle) return true;

            const panel = document.getElementById('bsub-panel');
            if (panel) showSummaryPanel(panel);
            STATE.isFetchingSubtitle = true;
            STATE.subtitleFetchFailed = false;
            updateUI();

            installSubtitleRequestHooks();
            const opened = autoOpenSubtitle();
            if (!opened) {
                removeSubtitleRequestHooks?.();
                STATE.isFetchingSubtitle = false;
                STATE.subtitleFetchFailed = true;
                updateUI();
                showToast('没能打开字幕菜单，请确认该视频提供字幕');
                return false;
            }

            // 延续「触发字幕请求 → Hook 收到 JSON」的流程。
            const waitPoll = setInterval(() => {
                if (STATE.interceptedSubtitles.length > 0) {
                    clearInterval(waitPoll);
                    STATE.activePolls.delete(waitPoll);
                    clearTimeout(STATE.subtitleWaitTimeout);
                    STATE.subtitleWaitTimeout = null;
                    STATE.isFetchingSubtitle = false;
                    updateUI();
                    generateAISummary();
                }
            }, 500);
            STATE.activePolls.add(waitPoll);
            STATE.subtitleWaitTimeout = setTimeout(() => {
                clearInterval(waitPoll);
                STATE.activePolls.delete(waitPoll);
                STATE.subtitleWaitTimeout = null;
                removeSubtitleRequestHooks?.();
                finishSubtitleHover();
                STATE.isFetchingSubtitle = false;
                STATE.subtitleFetchFailed = true;
                updateUI();
                showToast('获取字幕超时，请确认该视频提供字幕');
            }, 15000);
            return true;
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
            let hasRenderedProgress = false;

            STATE.isGenerating = true;
            STATE.summaryRequest = { id: requestId, controller };
            if (STATE.panelView === 'lines') setPanelView('summary');
            showSummaryPanel(panel);
            statusEl.textContent = '生成中…';
            statusEl.style.color = '#86868b';
            setSummaryActionsVisible(false);
            refreshBtn?.classList.add('spinning');
            updateUI();

            const renderSummary = text => {
                const previousScrollTop = contentEl.scrollTop;
                const followBottom = !hasRenderedProgress
                    || contentEl.scrollHeight - contentEl.clientHeight - previousScrollTop <= 16;
                contentEl.innerHTML = renderMarkdown(text);
                contentEl.scrollTop = followBottom ? contentEl.scrollHeight : previousScrollTop;
                hasRenderedProgress = true;
            };

            const renderProgress = text => {
                fullText = text;
                if (renderFrame) return;
                renderFrame = requestAnimationFrame(() => {
                    renderFrame = 0;
                    if (STATE.summaryRequest?.id !== requestId) return;
                    renderSummary(fullText);
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
                    renderSummary(fullText);
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
                    renderSummary(fullText);
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

        function getActiveVideo() {
            const videos = [...document.querySelectorAll('video')];
            return videos.find(item => Number.isFinite(item.duration) && item.duration > 0) || videos[0] || null;
        }

        function seekVideoTo(seconds) {
            const video = getActiveVideo();
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
        // 逐句字幕视图 — 可点击跳转，并跟随播放高亮当前行
        // ============================================================

        function getSubtitleLines() {
            const body = getFirstSubtitle()?.body || [];
            return body
                .map(item => {
                    const content = typeof item?.content === 'string' ? item.content.trim() : '';
                    const from = Number(item?.from);
                    return { content, from: Number.isFinite(from) && from >= 0 ? from : null };
                })
                .filter(line => line.content);
        }

        function renderSubtitleLines() {
            const list = document.getElementById('bsub-lines-list');
            if (!list) return;
            list.replaceChildren();
            STATE.subtitleActiveIndex = -1;

            const lines = getSubtitleLines();
            STATE.subtitleLines = lines;
            const countEl = document.getElementById('bsub-lines-count');
            if (countEl) countEl.textContent = lines.length ? `字幕 ${lines.length} 行` : '暂无字幕';

            if (!lines.length) {
                const empty = document.createElement('div');
                empty.className = 'bsub-history-empty';
                empty.textContent = '没有可用的字幕数据';
                list.appendChild(empty);
                return;
            }

            const fragment = document.createDocumentFragment();
            lines.forEach((line, index) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'bsub-line';
                row.dataset.index = String(index);
                if (line.from !== null) row.dataset.start = String(line.from);
                row.title = '跳转到该时间点';

                const time = document.createElement('span');
                time.className = 'bsub-line-time';
                time.textContent = line.from !== null ? formatTimestamp(line.from) : '--:--';
                const text = document.createElement('span');
                text.className = 'bsub-line-text';
                text.textContent = line.content;
                row.append(time, text);
                fragment.appendChild(row);
            });
            list.appendChild(fragment);
        }

        function setActiveSubtitleLine(index, scroll = true) {
            const list = document.getElementById('bsub-lines-list');
            if (!list || index === STATE.subtitleActiveIndex) return;

            const previous = list.querySelector('.bsub-line.active');
            if (previous) previous.classList.remove('active');
            STATE.subtitleActiveIndex = index;
            if (index < 0) return;

            const row = list.querySelector(`.bsub-line[data-index="${index}"]`);
            if (!row) return;
            row.classList.add('active');
            if (scroll && STATE.subtitleFollow) row.scrollIntoView({ block: 'nearest' });
        }

        // 线性扫描字幕时间轴；timeupdate 约 4 次/秒，行数在数千级，开销可忽略。
        function findSubtitleIndexAt(currentTime) {
            const lines = STATE.subtitleLines;
            if (!lines.length || !Number.isFinite(currentTime)) return -1;
            const target = currentTime + 0.25;
            let index = -1;
            for (let i = 0; i < lines.length; i += 1) {
                const from = lines[i].from;
                if (from === null) continue;
                if (from > target) break;
                index = i;
            }
            return index;
        }

        function handlePlaybackTime() {
            const panel = document.getElementById('bsub-panel');
            if (!panel || !panel.classList.contains('visible') || STATE.panelView !== 'lines') return;
            const video = getActiveVideo();
            if (!video) return;
            setActiveSubtitleLine(findSubtitleIndexAt(video.currentTime));
        }

        function detachSubtitleFollow() {
            const entry = STATE.subtitleTimeHandler;
            if (entry) entry.video.removeEventListener('timeupdate', entry.handler);
            STATE.subtitleTimeHandler = null;
        }

        function attachSubtitleFollow() {
            detachSubtitleFollow();
            const video = getActiveVideo();
            if (!video) return;
            const handler = () => handlePlaybackTime();
            video.addEventListener('timeupdate', handler);
            STATE.subtitleTimeHandler = { video, handler };
            handlePlaybackTime();
        }

        function updateSubtitleFollowButton() {
            const button = document.getElementById('bsub-lines-follow');
            if (!button) return;
            button.setAttribute('aria-pressed', String(STATE.subtitleFollow));
            button.textContent = STATE.subtitleFollow ? '跟随播放' : '已暂停跟随';
        }

        function setPanelView(view) {
            const panel = document.getElementById('bsub-panel');
            const button = document.getElementById('bsub-subtitles-btn');
            if (!panel) return;
            STATE.panelView = view === 'lines' ? 'lines' : 'summary';
            panel.classList.toggle('bsub-view-lines', STATE.panelView === 'lines');
            if (button) button.setAttribute('aria-pressed', String(STATE.panelView === 'lines'));

            if (STATE.panelView === 'lines') {
                setHistoryVisible(false);
                renderSubtitleLines();
                updateSubtitleFollowButton();
                attachSubtitleFollow();
            } else {
                detachSubtitleFollow();
            }
        }

        // ============================================================
        // Markdown 渲染器 — 零依赖，支持标题/列表/引用/表格/代码块/加粗斜体
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

            // 4. 逐行解析：标题 / 列表 / 引用 / 表格 / 分割线
            const lines = text.split('\n');
            const out = [];
            const tableBlocks = [];
            let inUl = false;
            let inOl = false;

            function closeLists() {
                if (inUl) { out.push('</ul>'); inUl = false; }
                if (inOl) { out.push('</ol>'); inOl = false; }
            }

            function splitTableRow(line) {
                const trimmed = line.trim();
                if (!trimmed.includes('|')) return null;
                const row = trimmed.replace(/^\|/, '').replace(/\|$/, '')
                    .split('|').map(cell => cell.trim());
                return row.length ? row : null;
            }

            function tableAlignment(cell) {
                const token = cell.trim();
                if (!/^:?-{3,}:?$/.test(token)) return null;
                if (token.startsWith(':') && token.endsWith(':')) return 'center';
                if (token.startsWith(':')) return 'left';
                if (token.endsWith(':')) return 'right';
                return '';
            }

            function buildTable(header, alignments, rows) {
                const cellHtml = (tag, cell, index) => {
                    const align = alignments[index];
                    const attr = align ? ' style="text-align:' + align + '"' : '';
                    return '<' + tag + attr + '>' + (cell || '') + '</' + tag + '>';
                };
                const headHtml = '<thead><tr>' + header.map((cell, index) => cellHtml('th', cell, index)).join('') + '</tr></thead>';
                const bodyHtml = rows.length
                    ? '<tbody>' + rows.map(row => '<tr>' + header.map((_, index) => cellHtml('td', row[index], index)).join('') + '</tr>').join('') + '</tbody>'
                    : '';
                return '<table class="bsub-md-table">' + headHtml + bodyHtml + '</table>';
            }

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];

                // 表格：表头下一行必须是 Markdown 分隔行，避免误识别普通文本。
                const headerCells = splitTableRow(line);
                const dividerCells = i + 1 < lines.length ? splitTableRow(lines[i + 1]) : null;
                if (headerCells && headerCells.length >= 2 && dividerCells && dividerCells.length === headerCells.length) {
                    const alignments = dividerCells.map(tableAlignment);
                    if (alignments.every(alignment => alignment !== null)) {
                        const rows = [];
                        let next = i + 2;
                        while (next < lines.length) {
                            const row = splitTableRow(lines[next]);
                            if (!row) break;
                            rows.push(row);
                            next++;
                        }
                        closeLists();
                        const tableIndex = tableBlocks.length;
                        tableBlocks.push(buildTable(headerCells, alignments, rows));
                        out.push('\u0000TABLE' + tableIndex + '\u0000');
                        i = next - 1;
                        continue;
                    }
                }

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

            // 先还原表格，再统一处理单元格中的加粗、斜体和时间点。
            text = text.replace(/\u0000TABLE(\d+)\u0000/g, (_, i) => tableBlocks[parseInt(i)]);

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
                        max-width: min(900px, calc(100vw - 48px));
                        box-sizing: border-box;
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
                    .bsub-resize {
                        position: absolute;
                        z-index: 2;
                        min-width: 0;
                        min-height: 0;
                        padding: 0;
                        border: 0;
                        background: transparent;
                        touch-action: none;
                    }
                    .bsub-resize-left, .bsub-resize-right {
                        top: 16px;
                        bottom: 16px;
                        width: 10px;
                        cursor: ew-resize;
                    }
                    .bsub-resize-left { left: 0; }
                    .bsub-resize-right { right: 0; }
                    .bsub-resize-top, .bsub-resize-bottom {
                        left: 16px;
                        right: 16px;
                        height: 10px;
                        cursor: ns-resize;
                    }
                    .bsub-resize-top { top: 0; }
                    .bsub-resize-bottom { bottom: 0; }
                    .bsub-resize:focus-visible { outline: 2px solid #007aff; outline-offset: -2px; }

                    /* 状态栏 */
                    #bsub-bar {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        cursor: move;
                        user-select: none;
                        touch-action: none;
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
                    #bsub-history-btn {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        width: 20px;
                        height: 20px;
                        padding: 0;
                        border: 0;
                        background: transparent;
                        color: inherit;
                        cursor: pointer;
                    }
                    #bsub-history-btn:hover,
                    #bsub-history-btn[aria-expanded="true"] { color: #007aff; }
                    #bsub-history-btn svg { width: 16px; height: 16px; }
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
                        overscroll-behavior-y: contain;
                        flex: 1;
                        font-size: 14px;
                        line-height: 1.75;
                        color: #1d1d1f;
                        word-break: break-word;
                        min-height: 80px;
                        max-height: 400px;
                    }
                    #bsub-panel.bsub-height-adjusted #bsub-content {
                        min-height: 0;
                        max-height: none;
                    }
                    #bsub-panel.bsub-show-history:not(.bsub-height-adjusted) #bsub-content {
                        min-height: 260px;
                    }

                    /* 逐句字幕视图 */
                    #bsub-subtitles-btn {
                        width: 20px;
                        height: 20px;
                        cursor: pointer;
                        opacity: 0.4;
                        transition: opacity 0.15s ease;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    #bsub-subtitles-btn:hover { opacity: 0.8; }
                    #bsub-subtitles-btn[aria-pressed="true"] { opacity: 1; color: #007aff; }
                    #bsub-subtitles-btn svg { width: 15px; height: 15px; }
                    #bsub-lines {
                        display: none;
                        flex: 1;
                        flex-direction: column;
                        min-height: 80px;
                        max-height: 400px;
                        overflow: hidden;
                    }
                    #bsub-panel.bsub-view-lines #bsub-lines { display: flex; }
                    #bsub-panel.bsub-view-lines #bsub-content { display: none; }
                    #bsub-panel.bsub-view-lines.bsub-height-adjusted #bsub-lines {
                        min-height: 0;
                        max-height: none;
                    }
                    #bsub-lines-head {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                        padding: 8px 16px;
                        border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
                        font-size: 12px;
                        color: #86868b;
                        flex-shrink: 0;
                    }
                    #bsub-lines-follow {
                        padding: 3px 9px;
                        border: 0.5px solid #d2d2d7;
                        border-radius: 10px;
                        background: transparent;
                        color: #86868b;
                        font-size: 11px;
                        font-family: inherit;
                        cursor: pointer;
                        transition: all 0.15s ease;
                    }
                    #bsub-lines-follow[aria-pressed="true"] {
                        border-color: rgba(0, 122, 255, 0.4);
                        background: rgba(0, 122, 255, 0.1);
                        color: #007aff;
                    }
                    #bsub-lines-list {
                        flex: 1;
                        overflow-y: auto;
                        overscroll-behavior-y: contain;
                        padding: 6px 8px 10px;
                    }
                    .bsub-line {
                        display: flex;
                        gap: 8px;
                        width: 100%;
                        padding: 6px 8px;
                        border: 0;
                        border-radius: 6px;
                        background: transparent;
                        color: #1d1d1f;
                        font-family: inherit;
                        font-size: 13px;
                        line-height: 1.6;
                        text-align: left;
                        cursor: pointer;
                        transition: background 0.15s ease;
                    }
                    .bsub-line:hover { background: rgba(0, 122, 255, 0.08); }
                    .bsub-line.active { background: rgba(0, 122, 255, 0.14); }
                    .bsub-line-time {
                        flex-shrink: 0;
                        color: #007aff;
                        font-variant-numeric: tabular-nums;
                    }
                    .bsub-line-text {
                        flex: 1;
                        min-width: 0;
                        overflow-wrap: anywhere;
                    }

                    #bsub-history {
                        display: none;
                        position: absolute;
                        z-index: 1;
                        right: 0;
                        bottom: 0;
                        left: 0;
                        overflow-y: auto;
                        overscroll-behavior-y: contain;
                        padding: 8px 12px;
                        background: rgba(255, 255, 255, 0.96);
                    }
                    .bsub-history-toolbar {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                        padding: 2px 8px 8px;
                        margin-bottom: 4px;
                        border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
                    }
                    .bsub-history-count,
                    .bsub-history-date,
                    .bsub-history-empty {
                        color: #86868b;
                        font-size: 12px;
                    }
                    .bsub-history-clear {
                        padding: 2px 4px;
                        border: none;
                        background: none;
                        color: #007aff;
                        font-size: 12px;
                        font-family: inherit;
                        cursor: pointer;
                        border-radius: 4px;
                        transition: color 0.15s ease;
                    }
                    .bsub-history-clear:hover { text-decoration: underline; }
                    .bsub-history-clear.armed { color: #ff3b30; font-weight: 600; }
                    .bsub-history-item {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        border-radius: 6px;
                        color: #1d1d1f;
                    }
                    .bsub-history-item:hover { background: rgba(0, 122, 255, 0.08); }
                    .bsub-history-link {
                        display: flex;
                        flex: 1;
                        min-width: 0;
                        flex-direction: column;
                        gap: 3px;
                        padding: 9px 8px;
                        color: inherit;
                        text-decoration: none;
                    }
                    .bsub-history-remove {
                        flex-shrink: 0;
                        width: 22px;
                        height: 22px;
                        margin-right: 6px;
                        padding: 0;
                        border: none;
                        border-radius: 50%;
                        background: none;
                        color: #aeaeb2;
                        font-size: 16px;
                        line-height: 1;
                        font-family: inherit;
                        cursor: pointer;
                        opacity: 0.6;
                        transition: all 0.15s ease;
                    }
                    .bsub-history-remove:hover {
                        background: rgba(255, 59, 48, 0.12);
                        color: #ff3b30;
                        opacity: 1;
                    }
                    .bsub-history-title { font-size: 13px; overflow-wrap: anywhere; }
                    .bsub-history-empty { padding: 16px 8px; }
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
                    #bsub-content .bsub-md-table {
                        width: 100%;
                        border-collapse: collapse;
                        margin: 10px 0;
                        font-size: 13px;
                    }
                    #bsub-content .bsub-md-table th,
                    #bsub-content .bsub-md-table td {
                        border: 1px solid rgba(0,0,0,0.12);
                        padding: 6px 8px;
                        vertical-align: top;
                        text-align: left;
                    }
                    #bsub-content .bsub-md-table th {
                        background: rgba(0,0,0,0.05);
                        font-weight: 600;
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
                    .bsub-settings-test {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        margin-top: 12px;
                    }
                    #bsub-settings-test {
                        flex-shrink: 0;
                        padding: 7px 14px;
                        border: 0.5px solid #d2d2d7;
                        border-radius: 8px;
                        background: transparent;
                        color: #007aff;
                        font-size: 13px;
                        font-family: inherit;
                        cursor: pointer;
                        transition: all 0.15s ease;
                    }
                    #bsub-settings-test:hover:not(:disabled) { background: rgba(0, 122, 255, 0.08); }
                    #bsub-settings-test:disabled { opacity: 0.5; cursor: default; }
                    #bsub-settings-test-result {
                        flex: 1;
                        min-width: 0;
                        font-size: 12px;
                        line-height: 1.4;
                        color: #86868b;
                        overflow-wrap: anywhere;
                    }
                    .bsub-prompt-tools {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        margin-top: 8px;
                    }
                    .bsub-prompt-tools button {
                        padding: 6px 10px;
                        border: 0.5px solid #d2d2d7;
                        border-radius: 8px;
                        background: transparent;
                        color: #007aff;
                        font-size: 12px;
                        font-family: inherit;
                        cursor: pointer;
                        transition: all 0.15s ease;
                    }
                    .bsub-prompt-tools button:hover:not(:disabled) { background: rgba(0, 122, 255, 0.08); }
                    .bsub-prompt-tools button:disabled { opacity: 0.4; cursor: default; }
                    #bsub-prompt-delete { color: #ff3b30; }
                    #bsub-prompt-delete:hover:not(:disabled) { background: rgba(255, 59, 48, 0.1); }
                    #bsub-prompt-delete.armed {
                        border-color: rgba(255, 59, 48, 0.45);
                        background: rgba(255, 59, 48, 0.14);
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
                        #bsub-history { background: rgba(30, 30, 32, 0.97); }
                        .bsub-history-item { color: #f5f5f7; }
                        .bsub-history-toolbar { border-bottom-color: rgba(255, 255, 255, 0.1); }
                        #bsub-lines-head { border-bottom-color: rgba(255, 255, 255, 0.1); }
                        .bsub-line { color: #f5f5f7; }
                        .bsub-line.active { background: rgba(10, 132, 255, 0.22); }
                        .bsub-line-time { color: #64d2ff; }
                        #bsub-lines-follow { border-color: rgba(255, 255, 255, 0.16); }
                        #bsub-settings-test { border-color: rgba(255, 255, 255, 0.16); }
                        #bsub-content .bsub-md-quote {
                            color: #aeaeb2;
                        }
                        #bsub-content .bsub-md-inline-code,
                        #bsub-content .bsub-md-code {
                            background: rgba(255, 255, 255, 0.1);
                        }
                        #bsub-content .bsub-md-table th,
                        #bsub-content .bsub-md-table td {
                            border-color: rgba(255,255,255,0.16);
                        }
                        #bsub-content .bsub-md-table th {
                            background: rgba(255,255,255,0.08);
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
                        .bsub-prompt-tools button {
                            border-color: rgba(255, 255, 255, 0.16);
                            color: #64a8ff;
                        }
                        #bsub-prompt-delete { color: #ff6b62; }
                        #bsub-prompt-delete.armed {
                            border-color: rgba(255, 107, 98, 0.5);
                            background: rgba(255, 107, 98, 0.16);
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
                    <button class="bsub-resize bsub-resize-left" data-edge="left" type="button" title="拖动调整面板宽度" aria-label="调整左边缘，使用左右方向键"></button>
                    <button class="bsub-resize bsub-resize-right" data-edge="right" type="button" title="拖动调整面板宽度" aria-label="调整右边缘，使用左右方向键"></button>
                    <button class="bsub-resize bsub-resize-top" data-edge="top" type="button" title="拖动调整面板高度" aria-label="调整上边缘，使用上下方向键"></button>
                    <button class="bsub-resize bsub-resize-bottom" data-edge="bottom" type="button" title="拖动调整面板高度" aria-label="调整下边缘，使用上下方向键"></button>
                    <div id="bsub-bar">
                        <div id="bsub-bar-info">
                            <button id="bsub-history-btn" type="button" title="本地总结历史" aria-label="本地总结历史" aria-expanded="false" aria-controls="bsub-history">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>
                            </button>
                            <span id="bsub-line-count">—</span>
                            <span class="dot-sep"></span>
                            <span id="bsub-status-text">就绪</span>
                        </div>
                        <div id="bsub-bar-actions">
                            <div id="bsub-subtitles-btn" title="逐句查看字幕" role="button" tabindex="0" aria-label="逐句查看字幕" aria-pressed="false">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                    <path d="M7 10h10M7 14h6"></path>
                                </svg>
                            </div>
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
                    <div id="bsub-lines" aria-label="逐句字幕">
                        <div id="bsub-lines-head">
                            <span id="bsub-lines-count">字幕</span>
                            <button id="bsub-lines-follow" type="button" aria-pressed="true">跟随播放</button>
                        </div>
                        <div id="bsub-lines-list"></div>
                    </div>
                    <div id="bsub-history" aria-label="本地总结历史"></div>
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
                                <input type="text" id="bsub-ai-model" placeholder="agnes-2.5-flash" />
                                <div class="bsub-field-hint">默认 agnes-2.5-flash，也可填写其他兼容模型</div>
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
                                <label class="bsub-field-label" for="bsub-prompt-template">提示词</label>
                                <select id="bsub-prompt-template"></select>
                                <div class="bsub-field-hint">内置模板可改动后保存，也可另存为自己的提示词</div>
                                <textarea id="bsub-ai-prompt" rows="4" placeholder="输入提示词，字幕内容会自动拼接到末尾"></textarea>
                                <div class="bsub-prompt-tools">
                                    <button id="bsub-prompt-save-as" type="button">另存为新的提示词</button>
                                    <button id="bsub-prompt-reset" type="button">恢复默认</button>
                                    <button id="bsub-prompt-delete" type="button">删除</button>
                                </div>
                                <div class="bsub-field-hint">只填写提示词部分，字幕文本由脚本自动拼接，无需手动插入</div>
                            </div>
                            <div class="bsub-settings-test">
                                <button id="bsub-settings-test" type="button">测试连接</button>
                                <span id="bsub-settings-test-result"></span>
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
            // 首次运行就把旧版单条提示词迁移成提示词库，而不是拖到第一次打开设置。
            getPromptLibrary();

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
            const panel = document.getElementById('bsub-panel');
            const savedWidth = Number(GM_getValue(PANEL_WIDTH_KEY, 380));
            if (Number.isFinite(savedWidth) && savedWidth >= 380 && savedWidth <= 900) {
                panel.style.width = savedWidth + 'px';
            }
            const savedHeight = Number(GM_getValue(PANEL_HEIGHT_KEY, 0));
            if (Number.isFinite(savedHeight) && savedHeight >= 160 && savedHeight <= 1200) {
                panel.style.height = savedHeight + 'px';
                panel.style.maxHeight = 'min(1200px, calc(100vh - 96px))';
                panel.classList.add('bsub-height-adjusted');
            }

            const resizePanel = (edge, rect, delta) => {
                const horizontal = edge === 'left' || edge === 'right';
                const available = horizontal
                    ? (edge === 'left' ? rect.right : window.innerWidth - rect.left)
                    : (edge === 'top' ? rect.bottom : window.innerHeight - rect.top);
                const maxSize = Math.max(1, Math.min(horizontal ? 900 : 1200,
                    horizontal ? window.innerWidth - 48 : window.innerHeight - 16, available));
                const minSize = Math.min(horizontal ? 380 : 160, maxSize);
                const startSize = horizontal ? rect.width : rect.height;
                const direction = edge === 'left' || edge === 'top' ? -1 : 1;
                const size = Math.round(Math.max(minSize, Math.min(maxSize, startSize + direction * delta)));
                if (horizontal) {
                    panel.style.width = size + 'px';
                    panel.style.left = (edge === 'left' ? rect.right - size : rect.left) + 'px';
                    panel.style.right = 'auto';
                } else {
                    panel.style.height = size + 'px';
                    panel.style.maxHeight = 'min(1200px, calc(100vh - 16px))';
                    panel.classList.add('bsub-height-adjusted');
                    panel.style.top = (edge === 'top' ? rect.bottom - size : rect.top) + 'px';
                    panel.style.bottom = 'auto';
                }
                return size;
            };
            const savePanelSize = (edge, size) => {
                if (edge === 'left' || edge === 'right') {
                    if (size >= 380) GM_setValue(PANEL_WIDTH_KEY, size);
                } else if (size >= 160) {
                    GM_setValue(PANEL_HEIGHT_KEY, size);
                }
            };
            document.querySelectorAll('.bsub-resize').forEach(handle => {
                const edge = handle.dataset.edge;
                const horizontal = edge === 'left' || edge === 'right';
                let start = null;
                handle.addEventListener('pointerdown', event => {
                    if (!event.isPrimary || event.button !== 0) return;
                    event.preventDefault();
                    start = {
                        coordinate: horizontal ? event.clientX : event.clientY,
                        rect: panel.getBoundingClientRect(),
                        style: panel.style.cssText,
                        heightAdjusted: panel.classList.contains('bsub-height-adjusted'),
                    };
                    handle.setPointerCapture(event.pointerId);
                });
                handle.addEventListener('pointermove', event => {
                    if (!start || !handle.hasPointerCapture(event.pointerId)) return;
                    resizePanel(edge, start.rect, (horizontal ? event.clientX : event.clientY) - start.coordinate);
                });
                handle.addEventListener('pointerup', event => {
                    if (!start || !handle.hasPointerCapture(event.pointerId)) return;
                    const size = resizePanel(edge, start.rect, (horizontal ? event.clientX : event.clientY) - start.coordinate);
                    savePanelSize(edge, size);
                    savePanelPosition(panel);
                    start = null;
                });
                handle.addEventListener('pointercancel', () => {
                    if (!start) return;
                    panel.style.cssText = start.style;
                    panel.classList.toggle('bsub-height-adjusted', start.heightAdjusted);
                    start = null;
                });
                handle.addEventListener('keydown', event => {
                    const backward = horizontal ? 'ArrowLeft' : 'ArrowUp';
                    const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
                    if (event.key !== backward && event.key !== forward) return;
                    event.preventDefault();
                    const size = resizePanel(edge, panel.getBoundingClientRect(), event.key === backward ? -20 : 20);
                    savePanelSize(edge, size);
                    savePanelPosition(panel);
                });
            });

            // 顶部空白区域用于拖动；字幕复制和其他按钮保留原有点击行为。
            const panelBar = document.getElementById('bsub-bar');
            let dragStart = null;
            panelBar.addEventListener('pointerdown', event => {
                if (!event.isPrimary || event.button !== 0 || event.target.closest('#bsub-history-btn, #bsub-line-count, #bsub-bar-actions')) return;
                event.preventDefault();
                const rect = panel.getBoundingClientRect();
                dragStart = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
                panelBar.setPointerCapture(event.pointerId);
            });
            panelBar.addEventListener('pointermove', event => {
                if (!dragStart || !panelBar.hasPointerCapture(event.pointerId)) return;
                const rect = panel.getBoundingClientRect();
                const left = Math.max(0, Math.min(window.innerWidth - rect.width, dragStart.left + event.clientX - dragStart.x));
                const top = Math.max(0, Math.min(window.innerHeight - rect.height, dragStart.top + event.clientY - dragStart.y));
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                dragStart.moved = true;
            });
            panelBar.addEventListener('pointerup', () => {
                if (dragStart?.moved) savePanelPosition(panel);
                dragStart = null;
            });
            panelBar.addEventListener('pointercancel', () => { dragStart = null; });
            window.addEventListener('resize', () => {
                if (panel.classList.contains('visible')) restorePanelPosition(panel);
            });

            document.getElementById('bsub-history-btn').addEventListener('click', () => {
                setHistoryVisible(!panel.classList.contains('bsub-show-history'));
            });

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
                    showSummaryPanel(panel);
                    return;
                }
                // 无字幕 → 自动获取后开始总结
                if (STATE.interceptedSubtitles.length === 0) {
                    captureSubtitlesThenSummarize();
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

            // 重新生成：字幕还没拦截到时先补一次获取，从本地历史恢复的总结也能直接重生成
            document.getElementById('bsub-refresh').addEventListener('click', () => {
                if (STATE.isGenerating) return;
                if (STATE.interceptedSubtitles.length === 0) {
                    captureSubtitlesThenSummarize();
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
                if (!STATE.lastSummaryMd) return;
                clearCurrentSummary();
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
            document.getElementById('bsub-settings-test').addEventListener('click', testApiConnection);
            document.getElementById('bsub-settings-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'bsub-settings-overlay') closeSettings();
            });

            const templateSelect = document.getElementById('bsub-prompt-template');
            const promptInput = document.getElementById('bsub-ai-prompt');
            templateSelect.addEventListener('change', () => {
                // 切换前先把当前编辑写回原条目，避免一次切换丢掉改动。
                commitPromptDraft();
                const library = getPromptLibrary();
                const entry = resolvePromptEntry(library, templateSelect.value);
                library.active = entry ? entry.key : 'general';
                savePromptLibrary(library);
                const current = getPromptLibrary();
                const active = resolvePromptEntry(current, current.active);
                promptInput.value = active ? active.prompt : DEFAULT_PROMPT;
                renderPromptSelect(current, current.active);
                updatePromptToolsState();
            });
            promptInput.addEventListener('input', updatePromptToolsState);
            document.getElementById('bsub-prompt-save-as').addEventListener('click', savePromptAsNew);
            document.getElementById('bsub-prompt-reset').addEventListener('click', resetPromptToDefault);
            document.getElementById('bsub-prompt-delete').addEventListener('click', deletePromptEntry);

            // 逐句字幕视图：切换、跟随开关与点击跳转
            STATE.subtitleFollow = GM_getValue(SUBTITLE_FOLLOW_KEY, true) !== false;
            updateSubtitleFollowButton();

            document.getElementById('bsub-subtitles-btn').addEventListener('click', () => {
                if (STATE.panelView === 'lines') {
                    setPanelView('summary');
                    return;
                }
                if (!getSubtitleLines().length) {
                    showToast('没有字幕数据');
                    return;
                }
                setPanelView('lines');
            });

            document.getElementById('bsub-lines-follow').addEventListener('click', () => {
                STATE.subtitleFollow = !STATE.subtitleFollow;
                GM_setValue(SUBTITLE_FOLLOW_KEY, STATE.subtitleFollow);
                updateSubtitleFollowButton();
                if (STATE.subtitleFollow) handlePlaybackTime();
            });

            document.getElementById('bsub-lines-list').addEventListener('click', event => {
                if (!(event.target instanceof Element)) return;
                const row = event.target.closest('.bsub-line');
                if (!row) return;
                const start = Number(row.dataset.start);
                if (!Number.isFinite(start)) return;
                if (!seekVideoTo(start)) {
                    showToast('未找到视频播放器');
                    return;
                }
                setActiveSubtitleLine(Number(row.dataset.index));
                showToast(`已跳转至 ${formatTimestamp(start)}`);
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

        // ---- 设置面板：提示词库交互 ----
        let promptDeleteTimer = null;

        function renderPromptSelect(library, selectedKey) {
            const select = document.getElementById('bsub-prompt-template');
            if (!select) return;
            const key = resolvePromptEntry(library, selectedKey) ? selectedKey : 'general';
            select.textContent = '';

            const builtinGroup = document.createElement('optgroup');
            builtinGroup.label = '内置模板';
            Object.entries(PROMPT_TEMPLATES).forEach(([id, template]) => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = template.label
                    + (Object.prototype.hasOwnProperty.call(library.overrides, id) ? '（已修改）' : '');
                builtinGroup.appendChild(option);
            });
            select.appendChild(builtinGroup);

            if (library.custom.length) {
                const customGroup = document.createElement('optgroup');
                customGroup.label = '我的提示词';
                library.custom.forEach(item => {
                    const option = document.createElement('option');
                    option.value = 'custom:' + item.id;
                    option.textContent = item.name;
                    customGroup.appendChild(option);
                });
                select.appendChild(customGroup);
            }

            select.value = key;
        }

        function disarmPromptDelete() {
            clearTimeout(promptDeleteTimer);
            promptDeleteTimer = null;
            const deleteButton = document.getElementById('bsub-prompt-delete');
            if (!deleteButton || !deleteButton.classList.contains('armed')) return;
            deleteButton.classList.remove('armed');
            deleteButton.textContent = '删除';
        }

        // 按钮可用性取决于「文本框与条目原文的差异」，编辑后立即生效，不必先保存。
        function updatePromptToolsState() {
            const promptInput = document.getElementById('bsub-ai-prompt');
            const resetButton = document.getElementById('bsub-prompt-reset');
            const deleteButton = document.getElementById('bsub-prompt-delete');
            if (!promptInput || !resetButton || !deleteButton) return;
            const library = getPromptLibrary();
            const entry = resolvePromptEntry(library, library.active);
            const isCustom = !!entry && entry.kind === 'custom';
            const original = !entry ? '' : (entry.kind === 'builtin' ? PROMPT_TEMPLATES[entry.id].prompt : entry.prompt);
            const differs = !!entry && promptInput.value.trim() !== original.trim();
            resetButton.disabled = !entry || isCustom || !differs;
            deleteButton.disabled = !isCustom;
            if (!isCustom) disarmPromptDelete();
        }

        // 把文本框内容写回当前选中的条目；未改动时不做任何写入。
        function commitPromptDraft() {
            const promptInput = document.getElementById('bsub-ai-prompt');
            if (!promptInput) return false;
            const library = getPromptLibrary();
            const entry = resolvePromptEntry(library, library.active);
            if (!entry) return false;
            const text = normalizePromptText(promptInput.value);
            if (!text || text === entry.prompt) return false;

            if (entry.kind === 'builtin') {
                // 改回默认内容时自动取消覆盖，避免留下无意义的“已修改”标记。
                if (text === PROMPT_TEMPLATES[entry.id].prompt.trim()) delete library.overrides[entry.id];
                else library.overrides[entry.id] = text;
            } else {
                const item = library.custom.find(row => row.id === entry.id);
                if (!item) return false;
                item.prompt = text;
            }
            savePromptLibrary(library);
            return true;
        }

        function savePromptAsNew() {
            const promptInput = document.getElementById('bsub-ai-prompt');
            if (!promptInput) return;
            const library = getPromptLibrary();
            if (library.custom.length >= PROMPT_CUSTOM_LIMIT) {
                showToast(`最多保存 ${PROMPT_CUSTOM_LIMIT} 条自定义提示词`);
                return;
            }
            const text = normalizePromptText(promptInput.value) || getActivePromptText();
            if (!text) {
                showToast('请先填写提示词内容');
                return;
            }

            const entry = resolvePromptEntry(library, library.active);
            let name = null;
            try {
                name = window.prompt('为这条提示词起个名字', (entry && entry.name) || '我的提示词');
            } catch (error) {
                name = '';
            }
            if (name === null) return;

            const item = {
                id: createPromptId(),
                name: normalizePromptName(name) || `提示词 ${library.custom.length + 1}`,
                prompt: text,
            };
            library.custom.push(item);
            library.active = 'custom:' + item.id;
            savePromptLibrary(library);

            const current = getPromptLibrary();
            renderPromptSelect(current, current.active);
            promptInput.value = item.prompt;
            updatePromptToolsState();
            showToast(`已保存为「${item.name}」`);
        }

        function resetPromptToDefault() {
            const promptInput = document.getElementById('bsub-ai-prompt');
            const library = getPromptLibrary();
            const entry = resolvePromptEntry(library, library.active);
            if (!promptInput || !entry || entry.kind !== 'builtin') return;

            delete library.overrides[entry.id];
            savePromptLibrary(library);
            const defaultText = PROMPT_TEMPLATES[entry.id].prompt;
            GM_setValue(AI_CONFIG_KEYS.prompt, defaultText);

            const current = getPromptLibrary();
            promptInput.value = defaultText;
            renderPromptSelect(current, current.active);
            updatePromptToolsState();
            showToast(`已恢复「${entry.name}」的默认内容`);
        }

        function deletePromptEntry() {
            const deleteButton = document.getElementById('bsub-prompt-delete');
            const promptInput = document.getElementById('bsub-ai-prompt');
            const library = getPromptLibrary();
            const entry = resolvePromptEntry(library, library.active);
            if (!deleteButton || !promptInput || !entry || entry.kind !== 'custom') return;

            // 二次确认：3 秒内未再次点击则自动取消。
            if (!deleteButton.classList.contains('armed')) {
                deleteButton.classList.add('armed');
                deleteButton.textContent = '确认删除？';
                clearTimeout(promptDeleteTimer);
                promptDeleteTimer = setTimeout(disarmPromptDelete, 3000);
                return;
            }

            disarmPromptDelete();
            library.custom = library.custom.filter(row => row.id !== entry.id);
            library.active = 'general';
            savePromptLibrary(library);

            const current = getPromptLibrary();
            const next = resolvePromptEntry(current, current.active);
            const text = next ? next.prompt : DEFAULT_PROMPT;
            GM_setValue(AI_CONFIG_KEYS.prompt, text);
            promptInput.value = text;
            renderPromptSelect(current, current.active);
            updatePromptToolsState();
            showToast(`已删除「${entry.name}」`);
        }

        function openSettings() {
            const c = getAIConfig();
            document.getElementById('bsub-ai-url').value = c.apiUrl;
            document.getElementById('bsub-ai-key').value = c.apiKey;
            document.getElementById('bsub-ai-model').value = c.model;
            document.getElementById('bsub-subtitle-preference').value = SUBTITLE_PREFERENCES[c.subtitlePreference] ? c.subtitlePreference : 'ai-zh';
            const library = getPromptLibrary();
            const promptEntry = resolvePromptEntry(library, library.active);
            document.getElementById('bsub-ai-prompt').value = promptEntry ? promptEntry.prompt : (c.prompt || DEFAULT_PROMPT);
            renderPromptSelect(library, library.active);
            updatePromptToolsState();
            const testResult = document.getElementById('bsub-settings-test-result');
            if (testResult) {
                testResult.textContent = '';
                testResult.style.color = '#86868b';
            }
            document.getElementById('bsub-settings-overlay').classList.add('visible');
        }

        function closeSettings() {
            document.getElementById('bsub-settings-overlay').classList.remove('visible');
        }

        // 只发送一句极短的请求，用于确认 URL、Key 与模型三者是否配套。
        async function testApiConnection() {
            const button = document.getElementById('bsub-settings-test');
            const resultEl = document.getElementById('bsub-settings-test-result');
            if (!button || !resultEl) return;

            const config = {
                apiUrl: normalizeApiUrl(document.getElementById('bsub-ai-url').value),
                apiKey: document.getElementById('bsub-ai-key').value.trim(),
                model: document.getElementById('bsub-ai-model').value.trim(),
            };
            const setResult = (text, color) => {
                resultEl.textContent = text;
                resultEl.style.color = color;
            };

            if (!config.apiUrl || !config.apiKey || !config.model) {
                setResult('请先填写 API URL、API Key 与模型', '#ff9500');
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            button.disabled = true;
            button.textContent = '测试中…';
            setResult('正在连接…', '#86868b');
            try {
                const text = await requestAISummary(config, {
                    model: config.model,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 8,
                    stream: true,
                }, controller.signal, () => {});
                setResult(text ? '连接成功，模型可以正常返回内容' : '连接成功，但模型没有返回内容', text ? '#34c759' : '#ff9500');
            } catch (error) {
                if (error?.name === 'AbortError') {
                    setResult('连接超时（20 秒内没有响应）', '#ff3b30');
                } else if (error?.message === '模型未返回总结内容') {
                    setResult('连接成功，但模型没有返回内容', '#ff9500');
                } else {
                    setResult(error?.message || '连接失败', '#ff3b30');
                }
            } finally {
                clearTimeout(timeoutId);
                button.disabled = false;
                button.textContent = '测试连接';
            }
        }

        function saveSettings() {
            const apiUrl = normalizeApiUrl(document.getElementById('bsub-ai-url').value);
            // 先落盘提示词改动：内置模板的改写也会一并留存。
            commitPromptDraft();
            saveAIConfig({
                apiUrl,
                apiKey: document.getElementById('bsub-ai-key').value.trim(),
                model: document.getElementById('bsub-ai-model').value.trim(),
                prompt: getActivePromptText() || DEFAULT_PROMPT,
                subtitlePreference: document.getElementById('bsub-subtitle-preference').value,
            });
            document.getElementById('bsub-ai-url').value = apiUrl;
            closeSettings();
            const looksComplete = !apiUrl || /completions$/i.test(apiUrl);
            showToast(looksComplete ? '已保存' : '已保存，但 API URL 通常以 /chat/completions 结尾');
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
            } else if (STATE.lastSummaryMd && !STATE.subtitleFetchFailed) {
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
                _toastEl.style.cssText = `
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
            setHistoryVisible(false);

            STATE.summaryRequest?.controller.abort();
            STATE.summaryRequest = null;
            STATE.isGenerating = false;
            document.getElementById('bsub-refresh')?.classList.remove('spinning');
            clearTimeout(STATE.subtitleCopyResetTimer);
            STATE.subtitleCopyResetTimer = null;
            clearTimeout(STATE.subtitleWaitTimeout);
            STATE.subtitleWaitTimeout = null;
            removeSubtitleRequestHooks?.();
            if (STATE.isFetchingSubtitle) finishSubtitleHover();
            detachSubtitleFollow();
            setPanelView('summary');

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
                STATE.subtitleLines = [];
                STATE.subtitleActiveIndex = -1;
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
