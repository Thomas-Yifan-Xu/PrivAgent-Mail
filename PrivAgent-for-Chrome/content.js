// Copyright (c) 2025 Yifan Xu, Jietong Zhou, Yihang Zou, Yuchu Guo
(() => {
    const tooltip = document.createElement('div');
    tooltip.id = 'gmail-hover-preview-tooltip';
    document.body.appendChild(tooltip);

    let currentHoverRow = null;
    let tooltipPositionSet = false;
    let isMouseOnTooltip = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let hideTooltipTimer = null; // 延时关闭定时器
    const HIDE_DELAY = 200; // 延时关闭时间（毫秒）
    const summaryCache = new Map();
    const authState = {
        checked: false,
        authenticated: false,
        promise: null
    };

    const LABEL_BUTTON_PREFIX = 'Add label: ';
    const LABEL_ADDING_TEXT = 'Adding label...';
    const LABEL_ADDED_PREFIX = 'Label added: ';
    const LABEL_APPLY_SUCCESS = 'Label added to this thread.';
    const LABEL_APPLY_ERROR_FALLBACK = 'Unable to add label.';
    let labelButtonHandlerAttached = false;

    const SIGN_IN_PROMPT = 'Please sign in using the extension popup to view AI summaries.';
    const AUTH_CHECK_TEXT = 'Checking sign-in status...';
    const SUMMARY_LOADING_TEXT = 'Generating AI summary...';
    const OPENAI_CONFIG_PROMPT = 'Add your OpenAI endpoint and API key in the extension popup to enable summaries.';
    const EMPTY_EMAIL_TEXT = 'No readable content found for this email.';
    const GENERIC_ERROR_TEXT = 'Failed to generate summary.';
    const ACTION_CONFIDENCE_THRESHOLD = 0.6;
    const ACTION_FLAG_TEXT = 'ACTION NEEDED';
    const PRIVACY_PROTECTED_TEXT = 'Your Privacy has been Protected!';
    const PRIVACY_MESSAGE_CLASS = 'ghp-privacy-toast';
    const PRIVACY_MESSAGE_DURATION_MS = 2400;
    const PRIVACY_BG_FADE_DURATION_MS = 600;
    const MASK_CLEAR_CLASS = 'ghp-mask-highlight-cleared';
    const TOAST_EDGE_PADDING = 12;

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const positionPrivacyToast = (toast, container, anchor) => {
        if (!toast || !container) {
            return;
        }

        requestAnimationFrame(() => {
            const containerRect = container.getBoundingClientRect();
            const toastRect = toast.getBoundingClientRect();
            if (!containerRect || !containerRect.width || !toastRect) {
                return;
            }

            const toastHalfWidth = toastRect.width / 2;
            let anchorCenter = containerRect.left + (containerRect.width / 2);
            if (anchor && typeof anchor.getBoundingClientRect === 'function') {
                const anchorRect = anchor.getBoundingClientRect();
                if (anchorRect && anchorRect.width) {
                    anchorCenter = anchorRect.left + (anchorRect.width / 2);
                }
            }

            let left = anchorCenter - containerRect.left;
            const minLeft = TOAST_EDGE_PADDING + toastHalfWidth;
            const maxLeft = Math.max(minLeft, containerRect.width - TOAST_EDGE_PADDING - toastHalfWidth);
            left = clamp(left, minLeft, maxLeft);

            toast.style.setProperty('--ghp-toast-left', `${left}px`);
        });
    };

    chrome.runtime.sendMessage(
        {
            type: 'REFRESH_USER_LABELS',
            payload: { interactive: false }
        },
        () => {
            // Ignore errors when refresh is triggered before authentication.
            if (chrome.runtime.lastError) {
                return;
            }
        }
    );

    const updateTooltipPosition = (e) => {
        // 只在首次显示时设置位置，之后保持固定位置
        if (tooltipPositionSet) {
            return;
        }

        const offsetX = 15;
        const offsetY = -8; // 向上移动30px（从15改为-15）
        let left = e.clientX + offsetX;
        let top = e.clientY + offsetY;

        if (left + tooltip.offsetWidth > window.innerWidth) {
            left = e.clientX - tooltip.offsetWidth - offsetX;
        }
        // 如果超出窗口顶部，显示在鼠标下方
        if (top < 0) {
            top = e.clientY - offsetY; // 显示在鼠标下方
        }
        // 如果超出窗口底部，显示在鼠标上方（但保持向上偏移）
        if (top + tooltip.offsetHeight > window.innerHeight) {
            top = e.clientY - tooltip.offsetHeight - offsetY;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltipPositionSet = true;
    };

    const hideTooltip = () => {
        // 清除延时关闭定时器
        if (hideTooltipTimer) {
            clearTimeout(hideTooltipTimer);
            hideTooltipTimer = null;
        }
        currentHoverRow = null;
        tooltipPositionSet = false;
        isMouseOnTooltip = false;
        tooltip.classList.remove('visible');
        delete tooltip.dataset.messageId;
    };

    // 取消延时关闭
    const cancelHideTooltip = () => {
        if (hideTooltipTimer) {
            clearTimeout(hideTooltipTimer);
            hideTooltipTimer = null;
        }
    };

    // 启动延时关闭
    const scheduleHideTooltip = () => {
        // 先清除之前的定时器
        cancelHideTooltip();
        // 设置新的延时关闭定时器
        hideTooltipTimer = setTimeout(() => {
            hideTooltip();
        }, HIDE_DELAY);
    };

    // 检查鼠标是否在悬浮窗或其扩展区域内
    const isMouseInTooltipArea = (target) => {
        if (!target) return false;
        // 检查是否在悬浮窗内
        if (target === tooltip || tooltip.contains(target)) {
            return true;
        }
        return false;
    };

    // 检查鼠标坐标是否在悬浮窗扩展区域内
    const isMouseInExtendedArea = (x, y) => {
        if (!tooltip.classList.contains('visible')) {
            return false;
        }
        const rect = tooltip.getBoundingClientRect();
        const extendedLeft = rect.left - 30; // 左边扩展30px
        const extendedRight = rect.right + 10; // 右边扩展10px
        const extendedTop = rect.top - 10; // 上边扩展10px
        const extendedBottom = rect.bottom + 10; // 下边扩展10px
        
        return x >= extendedLeft && x <= extendedRight && 
               y >= extendedTop && y <= extendedBottom;
    };

    // 检查鼠标是否在邮件行上
    const isMouseOnEmailRow = (target) => {
        if (!target) return false;
        const row = target.closest('tr.zA');
        return row !== null && row === currentHoverRow;
    };

    // 检查鼠标是否应该保持弹窗显示（在邮件行或悬浮窗上）
    const shouldKeepTooltipVisible = (target, x, y) => {
        // 检查是否在悬浮窗上
        if (isMouseInTooltipArea(target)) {
            return true;
        }
        // 检查是否在悬浮窗扩展区域内
        if (isMouseInExtendedArea(x, y)) {
            return true;
        }
        // 检查是否在当前邮件行上
        if (isMouseOnEmailRow(target)) {
            return true;
        }
        return false;
    };

    const ensureLayout = () => {
        if (!tooltip.querySelector('.ghp-meta')) {
            tooltip.innerHTML = `
                <div class="ghp-action-flag" hidden>${ACTION_FLAG_TEXT}</div>
                <div class="ghp-sender"></div>
                <div class="ghp-subject"></div>
                <div class="ghp-meta">
                    <div class="ghp-meta-left">
                        <div class="ghp-type"></div>
                    </div>
                    <button class="ghp-label-button" type="button" hidden></button>
                </div>
                <div class="ghp-label-feedback" hidden></div>
                <hr class="ghp-divider">
                <div class="ghp-snippet"></div>
            `;
        }

        const elements = {
            sender: tooltip.querySelector('.ghp-sender'),
            subject: tooltip.querySelector('.ghp-subject'),
            type: tooltip.querySelector('.ghp-type'),
            actionFlag: tooltip.querySelector('.ghp-action-flag'),
            snippet: tooltip.querySelector('.ghp-snippet'),
            labelButton: tooltip.querySelector('.ghp-label-button'),
            labelFeedback: tooltip.querySelector('.ghp-label-feedback')
        };

        if (elements.labelButton && !labelButtonHandlerAttached) {
            elements.labelButton.addEventListener('click', handleLabelButtonClick);
            labelButtonHandlerAttached = true;
        }

        return elements;
    };

    const showLabelFeedback = (elements, message, isError = false) => {
        if (!elements.labelFeedback) {
            return;
        }
        if (!message) {
            elements.labelFeedback.hidden = true;
            elements.labelFeedback.textContent = '';
            elements.labelFeedback.classList.remove('error');
            return;
        }
        elements.labelFeedback.hidden = false;
        elements.labelFeedback.textContent = message;
        elements.labelFeedback.classList.toggle('error', Boolean(isError));
    };

    const resetLabelButton = (elements) => {
        if (!elements.labelButton) {
            return;
        }
        elements.labelButton.hidden = true;
        elements.labelButton.disabled = false;
        elements.labelButton.dataset.label = '';
        elements.labelButton.dataset.messageId = '';
        elements.labelButton.dataset.state = 'idle';
        elements.labelButton.textContent = '';
        elements.labelButton.classList.remove('applied');
    };

    const updateLabelButton = (elements, label, applied = false) => {
        if (!elements.labelButton) {
            return;
        }

        if (!label || !tooltip.dataset.messageId) {
            resetLabelButton(elements);
            showLabelFeedback(elements, '');
            return;
        }

        elements.labelButton.hidden = false;
        elements.labelButton.dataset.label = label;
        elements.labelButton.dataset.messageId = tooltip.dataset.messageId;

        if (applied) {
            elements.labelButton.disabled = true;
            elements.labelButton.dataset.state = 'applied';
            elements.labelButton.classList.add('applied');
            elements.labelButton.textContent = `${LABEL_ADDED_PREFIX}${label}`;
            showLabelFeedback(elements, LABEL_APPLY_SUCCESS);
        } else {
            elements.labelButton.disabled = false;
            elements.labelButton.dataset.state = 'idle';
            elements.labelButton.classList.remove('applied');
            elements.labelButton.textContent = `${LABEL_BUTTON_PREFIX}${label}`;
            showLabelFeedback(elements, '');
        }
    };

    const updateActionFlag = (elements, replyDecision) => {
        if (!elements.actionFlag) {
            return;
        }

        const hasConfidence = typeof replyDecision?.confidence === 'number';
        const meetsCriteria = Boolean(
            replyDecision?.actionNeeded
            && hasConfidence
            && replyDecision.confidence >= ACTION_CONFIDENCE_THRESHOLD
            && !replyDecision.requiresHumanReview
        );

        if (meetsCriteria) {
            elements.actionFlag.hidden = false;
            elements.actionFlag.textContent = ACTION_FLAG_TEXT;
        } else {
            elements.actionFlag.hidden = true;
            elements.actionFlag.textContent = '';
        }
    };

    const logActionDecision = (messageId, replyDecision) => {
        if (!replyDecision || !replyDecision.reason) {
            return;
        }

        const parts = [
            `[PrivAgent] Action decision for message ${messageId}`,
            `actionNeeded=${replyDecision.actionNeeded ? 'true' : 'false'}`
        ];

        if (typeof replyDecision.confidence === 'number') {
            parts.push(`confidence=${replyDecision.confidence.toFixed(2)}`);
        }

        if (replyDecision.requiresHumanReview) {
            parts.push('requiresHumanReview=true');
        }

        parts.push(`reason=${replyDecision.reason}`);

        if (replyDecision.suggestedAction) {
            parts.push(`suggestedAction=${replyDecision.suggestedAction}`);
        }

        console.info(parts.join(' | '));
    };

    function handleLabelButtonClick(event) {
        event.preventDefault();
        const elements = ensureLayout();
        if (!elements.labelButton) {
            return;
        }

        const button = elements.labelButton;
        const cachedMessageId = button.dataset.messageId || tooltip.dataset.messageId || '';
        const label = button.dataset.label || '';

        if (!label || !cachedMessageId || button.disabled) {
            return;
        }

        button.disabled = true;
        button.dataset.state = 'pending';
        button.classList.remove('applied');
        button.textContent = LABEL_ADDING_TEXT;
        showLabelFeedback(elements, '');

        chrome.runtime.sendMessage(
            {
                type: 'APPLY_LABEL_TO_MESSAGE',
                payload: { messageId: cachedMessageId, label, interactive: true }
            },
            (response) => {
                if (tooltip.dataset.messageId !== cachedMessageId) {
                    return;
                }

                if (chrome.runtime.lastError || !response) {
                    const errorMessage = chrome.runtime.lastError?.message || LABEL_APPLY_ERROR_FALLBACK;
                    button.disabled = false;
                    button.dataset.state = 'idle';
                    button.textContent = `${LABEL_BUTTON_PREFIX}${label}`;
                    showLabelFeedback(elements, errorMessage, true);
                    return;
                }

                if (response.success) {
                    button.disabled = true;
                    button.dataset.state = 'applied';
                    button.classList.add('applied');
                    button.textContent = `${LABEL_ADDED_PREFIX}${label}`;
                    showLabelFeedback(elements, LABEL_APPLY_SUCCESS);
                    const cached = summaryCache.get(cachedMessageId);
                    if (cached) {
                        summaryCache.set(cachedMessageId, { ...cached, labelApplied: true });
                    }
                } else {
                    button.disabled = false;
                    button.dataset.state = 'idle';
                    button.textContent = `${LABEL_BUTTON_PREFIX}${label}`;
                    showLabelFeedback(elements, response.error || LABEL_APPLY_ERROR_FALLBACK, true);
                }
            }
        );
    }

    const extractEmailData = (row) => {
        const senderEl = row.querySelector('.yX .yW span') || row.querySelector('.zF') || row.querySelector('.yP');
        const subjectEl = row.querySelector('.bog');
        const snippetEl = row.querySelector('.y2');
        let messageId = row.getAttribute('data-legacy-last-message-id')
            || row.getAttribute('data-legacy-message-id')
            || row.getAttribute('data-message-id');

        if (!messageId) {
            const container = row.querySelector('[data-legacy-last-message-id]')
                || row.querySelector('[data-legacy-message-id]');
            if (container) {
                messageId = container.getAttribute('data-legacy-last-message-id')
                    || container.getAttribute('data-legacy-message-id');
            }
        }

        return {
            sender: senderEl ? senderEl.textContent.trim() : 'Unknown sender',
            subject: subjectEl ? subjectEl.textContent.trim() : '(No subject)',
            snippet: snippetEl ? snippetEl.textContent.replace(/^-\s*/, '').trim() : 'No preview available...',
            messageId
        };
    };

    const fetchEmailSummary = (messageId, interactive = false) => {
        if (summaryCache.has(messageId)) {
            const cached = summaryCache.get(messageId);
            logActionDecision(messageId, cached?.replyDecision || null);
            return Promise.resolve(cached);
        }

        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                {
                    type: 'FETCH_GMAIL_SUMMARY',
                    payload: { messageId, interactive }
                },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!response) {
                        reject(new Error('No response from extension.'));
                        return;
                    }
                    if (!response.success) {
                        const error = new Error(response.error || GENERIC_ERROR_TEXT);
                        if (response.code) {
                            error.code = response.code;
                        }
                        reject(error);
                        return;
                    }

                    const summary = response.data && typeof response.data.summary === 'string'
                        ? response.data.summary.trim()
                        : '';
                    const type = response.data && typeof response.data.type === 'string'
                        ? response.data.type.trim()
                        : '';
                    const label = response.data && typeof response.data.label === 'string'
                        ? response.data.label.trim()
                        : '';

                    if (!summary) {
                        const error = new Error(GENERIC_ERROR_TEXT);
                        error.code = 'SUMMARY_EMPTY';
                        reject(error);
                        return;
                    }

                    const replyDecisionSource = response.data && typeof response.data.replyDecision === 'object'
                        ? response.data.replyDecision
                        : null;
                    let replyDecision = null;
                    if (replyDecisionSource) {
                        const confidenceValue = typeof replyDecisionSource.confidence === 'number'
                            && Number.isFinite(replyDecisionSource.confidence)
                            ? replyDecisionSource.confidence
                            : null;
                        const rawActionNeeded = replyDecisionSource.actionNeeded;
                        const legacyNeedsReply = replyDecisionSource.needsReply;
                        const actionNeeded = typeof rawActionNeeded === 'boolean'
                            ? rawActionNeeded
                            : typeof legacyNeedsReply === 'boolean'
                                ? legacyNeedsReply
                                : Boolean(rawActionNeeded ?? legacyNeedsReply);
                        replyDecision = {
                            actionNeeded,
                            confidence: confidenceValue,
                            reason: typeof replyDecisionSource.reason === 'string'
                                ? replyDecisionSource.reason.trim()
                                : '',
                            requiresHumanReview: Boolean(replyDecisionSource.requiresHumanReview),
                            suggestedAction: typeof replyDecisionSource.suggestedAction === 'string'
                                ? replyDecisionSource.suggestedAction.trim()
                                : ''
                        };

                        if (!replyDecision.reason) {
                            replyDecision = null;
                        }
                    }

                    const previous = summaryCache.get(messageId);
                    const labelApplied = Boolean(previous?.labelApplied && previous?.label === label && label);
                    const payload = {
                        summary,
                        type,
                        label,
                        labelApplied,
                        replyDecision,
                        maskHighlights: Array.isArray(response.data?.maskHighlights)
                            ? response.data.maskHighlights
                            : []
                    };
                    summaryCache.set(messageId, payload);
                    logActionDecision(messageId, replyDecision);
                    resolve(payload);
                }
            );
        });
    };

    const renderSnippetContent = (element, text, highlightRanges = []) => {
        if (!element) {
            return;
        }

        element.textContent = '';

        if (!text) {
            return;
        }

        if (!Array.isArray(highlightRanges) || !highlightRanges.length) {
            element.textContent = text;
            return;
        }

        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let hasHighlights = false;
        let firstHighlightSpan = null;

        highlightRanges
            .filter((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end))
            .sort((a, b) => a.start - b.start)
            .forEach((range) => {
                const start = Math.max(0, Math.min(range.start, text.length));
                const end = Math.max(start, Math.min(range.end, text.length));
                if (start > cursor) {
                    fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
                }
                if (end > start) {
                    const span = document.createElement('span');
                    span.className = 'ghp-mask-highlight';
                    span.textContent = text.slice(start, end);
                    span.title = 'Protected by PrivAgent — this text stayed private before calling the AI.';
                    fragment.appendChild(span);
                    if (!firstHighlightSpan) {
                        firstHighlightSpan = span;
                    }
                    window.setTimeout(() => {
                        span.classList.add(MASK_CLEAR_CLASS);
                    }, Math.max(0, PRIVACY_MESSAGE_DURATION_MS - PRIVACY_BG_FADE_DURATION_MS));
                    hasHighlights = true;
                }
                cursor = Math.max(cursor, end);
            });

        if (cursor < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(cursor)));
        }

        element.appendChild(fragment);

        if (hasHighlights) {
            const toast = document.createElement('span');
            toast.className = PRIVACY_MESSAGE_CLASS;
            toast.textContent = PRIVACY_PROTECTED_TEXT;
            element.appendChild(toast);
            positionPrivacyToast(toast, element, firstHighlightSpan);
        }
    };

    const showMessage = (elements, data) => {
        elements.sender.textContent = data.sender;
        elements.subject.textContent = data.subject;
        elements.type.textContent = data.type ? `Type: ${data.type}` : '';
        renderSnippetContent(elements.snippet, data.message, data.maskHighlights);
        updateLabelButton(elements, data.label, Boolean(data.labelApplied));
        updateActionFlag(elements, data.replyDecision || null);
    };

    const showStatusMessage = (elements, message) => {
        elements.type.textContent = '';
        renderSnippetContent(elements.snippet, message, []);
        updateLabelButton(elements, '', false);
        updateActionFlag(elements, null);
    };

    const ensureAuthStatus = () => {
        if (authState.checked) {
            return Promise.resolve(authState.authenticated);
        }

        if (authState.promise) {
            return authState.promise;
        }

        authState.promise = new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'CHECK_AUTH_STATUS' }, (response) => {
                authState.promise = null;

                if (chrome.runtime.lastError || !response) {
                    authState.checked = false;
                    authState.authenticated = false;
                    resolve(false);
                    return;
                }

                if (!response.success) {
                    authState.checked = false;
                    authState.authenticated = false;
                    resolve(false);
                    return;
                }

                authState.checked = true;
                authState.authenticated = Boolean(response.authenticated);
                resolve(authState.authenticated);
            });
        });

        return authState.promise;
    };

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'AUTH_STATUS_CHANGED') {
            const authenticated = Boolean(message.payload?.authenticated);
            authState.checked = true;
            authState.authenticated = authenticated;
            authState.promise = null;
            if (!authenticated) {
                summaryCache.clear();
            }
        } else if (message?.type === 'OPENAI_CONFIG_CHANGED') {
            summaryCache.clear();
            if (!message.payload?.configured && tooltip.classList.contains('visible')) {
                const elements = ensureLayout();
                showStatusMessage(elements, OPENAI_CONFIG_PROMPT);
            }
        }
    });

    // 监听悬浮窗的鼠标事件
    tooltip.addEventListener('mouseenter', () => {
        isMouseOnTooltip = true;
        cancelHideTooltip(); // 取消延时关闭
    });

    tooltip.addEventListener('mouseleave', () => {
        isMouseOnTooltip = false;
        // 启动延时关闭，但会在mousemove中检查是否应该取消
        scheduleHideTooltip();
    });

    // 监听鼠标移动，更新鼠标坐标并检查是否应该保持弹窗显示
    document.addEventListener('mousemove', (e) => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        
        // 如果弹窗可见，检查鼠标是否在应该保持显示的区域
        if (tooltip.classList.contains('visible')) {
            if (shouldKeepTooltipVisible(e.target, e.clientX, e.clientY)) {
                // 鼠标在邮件行或悬浮窗上，取消延时关闭
                cancelHideTooltip();
                isMouseOnTooltip = true;
            } else if (currentHoverRow) {
                // 鼠标不在相关区域，且当前有邮件行，启动延时关闭
                // 但只在还没有定时器时才启动，避免频繁创建
                if (!hideTooltipTimer) {
                    scheduleHideTooltip();
                }
            }
        }
    });

    document.addEventListener('mouseover', (e) => {
        // 检查鼠标是否在应该保持显示的区域（悬浮窗或扩展区域）
        if (shouldKeepTooltipVisible(e.target, lastMouseX, lastMouseY)) {
            // 如果鼠标在悬浮窗上，取消延时关闭
            cancelHideTooltip();
            isMouseOnTooltip = true;
        }

        const row = e.target.closest('tr.zA');

        if (!row) {
            // 如果鼠标不在邮件行上，且不在悬浮窗上，启动延时关闭
            if (currentHoverRow && !shouldKeepTooltipVisible(e.target, lastMouseX, lastMouseY)) {
                scheduleHideTooltip();
            }
            return;
        }

        // 如果鼠标在同一邮件行上，保持弹窗显示（位置已固定）
        if (currentHoverRow === row) {
            cancelHideTooltip(); // 取消延时关闭
            return;
        }

        // 新的邮件行，显示弹窗
        cancelHideTooltip(); // 取消任何待执行的关闭操作
        currentHoverRow = row;
        tooltipPositionSet = false; // 重置位置标志，允许设置新位置
        const data = extractEmailData(row);
        const elements = ensureLayout();

        tooltip.dataset.messageId = data.messageId || '';

        showMessage(elements, {
            sender: data.sender,
            subject: data.subject,
            type: '',
            label: '',
            labelApplied: false,
            message: AUTH_CHECK_TEXT
        });
        tooltip.classList.add('visible');
        updateTooltipPosition(e);

        if (!data.messageId) {
            showStatusMessage(elements, 'Unable to identify the message ID.');
            return;
        }

        ensureAuthStatus()
            .then((authenticated) => {
                if (!tooltip.classList.contains('visible') || tooltip.dataset.messageId !== data.messageId) {
                    return;
                }

                if (!authenticated) {
                    showStatusMessage(elements, SIGN_IN_PROMPT);
                    return;
                }

                showStatusMessage(elements, SUMMARY_LOADING_TEXT);

                fetchEmailSummary(data.messageId, false)
                    .then((summaryText) => {
                        if (!tooltip.classList.contains('visible') || tooltip.dataset.messageId !== data.messageId) {
                            return;
                        }

                        showMessage(elements, {
                            sender: data.sender,
                            subject: data.subject,
                            type: summaryText.type,
                            label: summaryText.label,
                            labelApplied: summaryText.labelApplied,
                            message: summaryText.summary,
                            maskHighlights: Array.isArray(summaryText.maskHighlights)
                                ? summaryText.maskHighlights
                                : [],
                            replyDecision: summaryText.replyDecision
                        });
                    })
                    .catch((err) => {
                        if (!tooltip.classList.contains('visible') || tooltip.dataset.messageId !== data.messageId) {
                            return;
                        }

                        if (err.code === 'AUTH_REQUIRED') {
                            authState.checked = true;
                            authState.authenticated = false;
                            showStatusMessage(elements, SIGN_IN_PROMPT);
                            return;
                        }

                        if (err.code === 'MISSING_OPENAI_CONFIG') {
                            showStatusMessage(elements, OPENAI_CONFIG_PROMPT);
                            return;
                        }

                        if (err.code === 'EMPTY_EMAIL') {
                            showStatusMessage(elements, EMPTY_EMAIL_TEXT);
                            return;
                        }

                        showStatusMessage(elements, err.message || GENERIC_ERROR_TEXT);
                    });
            })
            .catch(() => {
                if (!tooltip.classList.contains('visible') || tooltip.dataset.messageId !== data.messageId) {
                    return;
                }
                authState.checked = false;
                authState.authenticated = false;
                showStatusMessage(elements, SIGN_IN_PROMPT);
            });
    });

    console.log('PrivAgent Mail Smart Summary loaded with AI summary mode');
})();
