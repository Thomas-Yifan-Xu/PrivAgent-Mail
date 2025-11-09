// Copyright (c) 2025 Yifan Xu, Jietong Zhou, Yihang Zou, Yuchu Guo
const KEEP_MASK_MARKERS_ON_RESTORE = false;
const MASK_PLACEHOLDER_REGEX = /\{\{[A-Z0-9_|]+\}\}/g;

let privacyAnonymizerReady = false;
const runtimeGlobal = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

try {
    importScripts('lib/compromise.js', 'lib/anonymizer.js');
    privacyAnonymizerReady = Boolean(runtimeGlobal?.PrivacyAnonymizer);
} catch (error) {
    console.warn('Privacy anonymizer scripts failed to load:', error);
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GMAIL_LABELS_API = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';
const TOKEN_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';
const TOKEN_EXPIRED_CODE = 'TOKEN_EXPIRED';
const DEFAULT_SUMMARY_MODEL = 'gpt-4o';
const MAX_SUMMARY_SOURCE_CHARS = 12000;
const EMAIL_TYPE_OPTIONS = [
    'Work',
    'Personal',
    'Finance / Bills / Invoices',
    'Receipts',
    'Travel',
    'Orders / Shipping',
    'Account Security',
    'Notifications',
    'Newsletters / Subscriptions',
    'Events / Calendar',
    'Promotions / Marketing',
    'Spam / Junk',
    'Academic / Education'
];
const FALLBACK_EMAIL_TYPE = 'Notifications';

const emailTypeLookup = EMAIL_TYPE_OPTIONS.reduce((map, label) => {
    map.set(label.toLowerCase(), label);
    map.set(label.replace(/\s+/g, '').toLowerCase(), label);
    return map;
}, new Map());

const USER_LABEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let userLabelRecords = [];
let USER_LABELS = [];
let userLabelLookup = new Map();
let userLabelsLastFetched = 0;
let userLabelsPromise = null;

let manualSignOut = false;
let openAIConfig = { endpoint: '', apiKey: '', model: DEFAULT_SUMMARY_MODEL };
let openAIConfigLoaded = false;

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';
const ensureChatCompletionsPath = (value = '') => {
    const trimmed = (value || '').trim();
    if (!trimmed) {
        return '';
    }
    if (/\/chat\/completions(?:\/|\?|$)/i.test(trimmed)) {
        return trimmed;
    }
    const [base, query = ''] = trimmed.split('?');
    const normalizedBase = base.replace(/\/+$/, '');
    const suffixed = `${normalizedBase}${CHAT_COMPLETIONS_SUFFIX}`;
    return query ? `${suffixed}?${query}` : suffixed;
};

const hasMappingEntries = (mapping) => mapping && Object.keys(mapping).length > 0;

const escapeRegExp = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const applyPrivacyMasking = (text) => {
    if (!text || !privacyAnonymizerReady || !runtimeGlobal?.PrivacyAnonymizer?.anonymizeText) {
        return { maskedText: text, mapping: {} };
    }
    try {
        return runtimeGlobal.PrivacyAnonymizer.anonymizeText(text);
    } catch (error) {
        console.warn('Failed to anonymize email content:', error);
        return { maskedText: text, mapping: {} };
    }
};

const createExpandedPlaceholderLookup = (mapping) => {
    const expanded = new Map();
    Object.entries(mapping).forEach(([placeholder, value]) => {
        if (!placeholder) {
            return;
        }
        expanded.set(placeholder, value);
        const inner = placeholder.slice(2, -2);
        if (!inner.includes('|')) {
            return;
        }
        inner.split('|').forEach((segment) => {
            if (!segment) {
                return;
            }
            const singlePlaceholder = `{{${segment}}}`;
            if (!expanded.has(singlePlaceholder)) {
                expanded.set(singlePlaceholder, value);
            }
        });
    });
    return expanded;
};

const restoreMaskedText = (text, mapping) => {
    if (!text || !hasMappingEntries(mapping)) {
        return { text, highlights: [] };
    }

    let restored = '';
    let lastIndex = 0;
    const highlights = [];
    const placeholderLookup = createExpandedPlaceholderLookup(mapping);

    text.replace(MASK_PLACEHOLDER_REGEX, (placeholder, offset) => {
        restored += text.slice(lastIndex, offset);
        const original = placeholderLookup.get(placeholder);
        if (original) {
            const originalText = String(original);
            const startIndex = restored.length;
            const displayText = KEEP_MASK_MARKERS_ON_RESTORE
                ? `${originalText} (${placeholder})`
                : originalText;
            restored += displayText;
            highlights.push({
                start: startIndex,
                end: startIndex + originalText.length,
                placeholder,
                original: originalText
            });
        } else {
            restored += placeholder;
        }
        lastIndex = offset + placeholder.length;
    });

    if (lastIndex < text.length) {
        restored += text.slice(lastIndex);
    }

    return { text: restored, highlights };
};

const toUserLabelRecords = (labels = []) => {
    return labels
        .filter((label) => label?.type === 'user' && typeof label.name === 'string' && label.name.trim() && label.id)
        .map((label) => ({
            id: label.id,
            name: label.name.trim()
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
};

const rebuildUserLabelCache = (records = []) => {
    userLabelRecords = records;
    USER_LABELS = records.map((record) => record.name);
    userLabelLookup = new Map();
    records.forEach((record) => {
        userLabelLookup.set(record.name.toLowerCase(), record);
    });
    userLabelsLastFetched = Date.now();
};

const clearUserLabelCache = () => {
    userLabelRecords = [];
    USER_LABELS = [];
    userLabelLookup = new Map();
    userLabelsLastFetched = 0;
    userLabelsPromise = null;
};

const matchUserLabel = (labelName) => {
    if (!labelName) {
        return null;
    }
    const normalized = labelName.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    return userLabelLookup.get(normalized) || null;
};

const refreshUserLabels = async (interactive = false) => {
    if (manualSignOut && !interactive) {
        const error = new Error('Please sign in again to continue.');
        error.code = AUTH_REQUIRED_CODE;
        throw error;
    }

    let token;

    try {
        token = await getAuthToken(interactive);
    } catch (error) {
        throw error;
    }

    manualSignOut = false;

    try {
        const labels = await getAllLabels(token);
        const records = toUserLabelRecords(labels);
        rebuildUserLabelCache(records);
        return USER_LABELS;
    } catch (error) {
        if (error.code === TOKEN_EXPIRED_CODE) {
            await removeCachedToken(token);
            return refreshUserLabels(interactive);
        }
        throw error;
    }
};

const ensureUserLabels = async (interactive = false, { forceRefresh = false } = {}) => {
    const now = Date.now();
    const cacheValid = USER_LABELS.length && !forceRefresh && now - userLabelsLastFetched < USER_LABEL_REFRESH_INTERVAL_MS;

    if (cacheValid) {
        return USER_LABELS;
    }

    if (userLabelsPromise) {
        return userLabelsPromise;
    }

    userLabelsPromise = (async () => {
        try {
            return await refreshUserLabels(interactive);
        } finally {
            userLabelsPromise = null;
        }
    })();

    return userLabelsPromise;
};

const getAuthToken = (interactive) => {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message || 'Failed to retrieve Google access token.';
                const error = new Error(errorMessage);
                error.code = interactive ? 'AUTH_ERROR' : AUTH_REQUIRED_CODE;
                reject(error);
                return;
            }

            if (!token) {
                const error = new Error('Google access token unavailable.');
                error.code = interactive ? 'AUTH_ERROR' : AUTH_REQUIRED_CODE;
                reject(error);
                return;
            }

            resolve(token);
        });
    });
};

const removeCachedToken = (token) => {
    return new Promise((resolve) => {
        if (!token) {
            resolve();
            return;
        }
        chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
};

const decodeBody = (body) => {
    if (!body || !body.data) {
        return '';
    }

    try {
        const normalized = body.data.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(normalized);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
        console.error('Failed to decode Gmail message body', error);
        return '';
    }
};

const extractPayloadContent = (payload) => {
    let plainText = '';
    let htmlText = '';

    const walk = (part) => {
        if (!part) {
            return;
        }

        if (!plainText && part.mimeType === 'text/plain') {
            plainText = decodeBody(part.body);
        }
        if (!htmlText && part.mimeType === 'text/html') {
            htmlText = decodeBody(part.body);
        }

        if (part.parts && part.parts.length) {
            part.parts.forEach(walk);
        }
    };

    walk(payload);

    if (!plainText && payload?.body && payload.mimeType === 'text/plain') {
        plainText = decodeBody(payload.body);
    }

    if (!htmlText && payload?.body && payload.mimeType === 'text/html') {
        htmlText = decodeBody(payload.body);
    }

    return { plainText, htmlText };
};

const extractMessageHeaders = (payload) => {
    const headers = {
        subject: '',
        from: '',
        to: '',
        cc: '',
        bcc: ''
    };

    if (!payload?.headers?.length) {
        return headers;
    }

    payload.headers.forEach((header) => {
        const name = header?.name;
        const value = typeof header?.value === 'string' ? header.value.trim() : '';
        if (!name || !value) {
            return;
        }
        const lower = name.toLowerCase();
        if (lower === 'subject') {
            headers.subject = value;
        } else if (lower === 'from') {
            headers.from = value;
        } else if (lower === 'to') {
            headers.to = value;
        } else if (lower === 'cc') {
            headers.cc = value;
        } else if (lower === 'bcc') {
            headers.bcc = value;
        }
    });

    return headers;
};

const requestMessage = async (accessToken, messageId) => {
    const response = await fetch(`${GMAIL_API_BASE}/${encodeURIComponent(messageId)}?format=full`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (response.status === 401) {
        const error = new Error('Google token expired.');
        error.code = TOKEN_EXPIRED_CODE;
        throw error;
    }

    if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Gmail API request failed: ${response.status} ${errorText}`);
        error.code = 'API_ERROR';
        throw error;
    }

    const message = await response.json();
    const payload = message.payload || {};
    const content = extractPayloadContent(payload);
    const headers = extractMessageHeaders(payload);
    return {
        plainText: content.plainText,
        htmlText: content.htmlText,
        headers
    };
};

const fetchMessageFromApi = async (messageId, interactive) => {
    if (manualSignOut && !interactive) {
        const error = new Error('Please sign in again to continue.');
        error.code = AUTH_REQUIRED_CODE;
        throw error;
    }

    let token;

    try {
        token = await getAuthToken(interactive);
    } catch (error) {
        throw error;
    }

    manualSignOut = false;

    try {
        return await requestMessage(token, messageId);
    } catch (error) {
        if (error.code === TOKEN_EXPIRED_CODE) {
            await removeCachedToken(token);
            try {
                token = await getAuthToken(interactive);
            } catch (tokenError) {
                throw tokenError;
            }
            return requestMessage(token, messageId);
        }
        throw error;
    }
};

const checkAuthStatus = async () => {
    if (manualSignOut) {
        return false;
    }

    try {
        await getAuthToken(false);
        return true;
    } catch (error) {
        if (error.code === AUTH_REQUIRED_CODE) {
            return false;
        }
        throw error;
    }
};

// 获取所有标签 接下是初次创建添加标签
const getAllLabels = async (accessToken) => {
    const response = await fetch(GMAIL_LABELS_API, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (response.status === 401) {
        const error = new Error('Google token expired.');
        error.code = TOKEN_EXPIRED_CODE;
        throw error;
    }

    if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Gmail API request failed: ${response.status} ${errorText}`);
        error.code = 'API_ERROR';
        throw error;
    }

    const data = await response.json();
    return data.labels || [];
};

// 给邮件添加标签
const addLabelToMessage = async (accessToken, messageId, labelId) => {
    const response = await fetch(`${GMAIL_API_BASE}/${encodeURIComponent(messageId)}/modify`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            addLabelIds: [labelId]
        })
    });

    if (response.status === 401) {
        const error = new Error('Google token expired.');
        error.code = TOKEN_EXPIRED_CODE;
        throw error;
    }

    if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Failed to add label to message: ${response.status} ${errorText}`);
        error.code = 'API_ERROR';
        throw error;
    }

    return await response.json();
};

const assignLabelToMessage = async (messageId, labelName, interactive = false) => {
    if (!messageId || !labelName) {
        return { success: false, error: 'Missing required parameters.' };
    }

    let labelRecord = matchUserLabel(labelName);

    if (!labelRecord) {
        try {
            await ensureUserLabels(interactive, { forceRefresh: true });
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Unable to load labels.',
                code: error.code
            };
        }
        labelRecord = matchUserLabel(labelName);
    }

    if (!labelRecord) {
        return { success: false, error: `Label "${labelName}" not found.` };
    }

    const attemptApply = async (retrying = false) => {
        let token;
        try {
            token = await getAuthToken(interactive);
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Failed to authenticate.',
                code: error.code
            };
        }

        manualSignOut = false;

        try {
            await addLabelToMessage(token, messageId, labelRecord.id);
            return {
                success: true,
                label: labelRecord.name,
                labelId: labelRecord.id
            };
        } catch (error) {
            if (error.code === TOKEN_EXPIRED_CODE && !retrying) {
                await removeCachedToken(token);
                return attemptApply(true);
            }
            return {
                success: false,
                error: error.message || 'Failed to apply label.',
                code: error.code
            };
        }
    };

    return attemptApply(false);
};

const mapInteractiveErrorCode = (message) => {
    if (!message) {
        return 'AUTH_ERROR';
    }
    const lower = message.toLowerCase();
    if (lower.includes('did not approve') || lower.includes('denied') || lower.includes('closed the window')) {
        return 'USER_DISMISSED';
    }
    return 'AUTH_ERROR';
};

const revokeToken = async (token) => {
    if (!token) {
        return;
    }

    try {
        const params = new URLSearchParams();
        params.set('token', token);
        await fetch(TOKEN_REVOKE_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });
    } catch (error) {
        console.warn('Failed to revoke OAuth token', error);
    }
};

const convertHtmlToPlainText = (html) => {
    if (!html) {
        return '';
    }

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (error) {
        console.warn('Failed to convert HTML to plain text', error);
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
};

const limitTextLength = (text, maxLength) => {
    if (!text) {
        return '';
    }
    return text.length > maxLength ? text.slice(0, maxLength) : text;
};

const canonicalizeEmailType = (value) => {
    if (!value) {
        return FALLBACK_EMAIL_TYPE;
    }

    const normalized = value.toString().trim();
    if (!normalized) {
        return FALLBACK_EMAIL_TYPE;
    }

    const lower = normalized.toLowerCase();
    if (emailTypeLookup.has(lower)) {
        return emailTypeLookup.get(lower);
    }

    const stripped = lower.replace(/[^a-z]/g, '');
    if (emailTypeLookup.has(stripped)) {
        return emailTypeLookup.get(stripped);
    }

    for (const label of EMAIL_TYPE_OPTIONS) {
        const simplified = label.replace(/[^a-z]/gi, '').toLowerCase();
        if (stripped && simplified.includes(stripped)) {
            return label;
        }
        if (lower.includes(label.toLowerCase())) {
            return label;
        }
    }

    return FALLBACK_EMAIL_TYPE;
};

const clampConfidence = (value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
    }
    if (!Number.isFinite(value)) {
        return null;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
};

const parseActionDecision = (rawDecision) => {
    if (!rawDecision || typeof rawDecision !== 'object') {
        const error = new Error('Model output missing reply_decision object.');
        error.code = 'OPENAI_INVALID_REPLY_DECISION';
        throw error;
    }

    if (typeof rawDecision.action_needed !== 'boolean') {
        const error = new Error('reply_decision.action_needed must be boolean.');
        error.code = 'OPENAI_INVALID_REPLY_DECISION';
        throw error;
    }

    const reason = typeof rawDecision.reason === 'string' ? rawDecision.reason.trim() : '';
    if (!reason) {
        const error = new Error('reply_decision.reason must be a non-empty string.');
        error.code = 'OPENAI_INVALID_REPLY_DECISION';
        throw error;
    }

    const confidence = clampConfidence(rawDecision.confidence);
    const requiresHumanReview = typeof rawDecision.requires_human_review === 'boolean'
        ? rawDecision.requires_human_review
        : false;
    const suggestedAction = typeof rawDecision.suggested_action === 'string'
        ? rawDecision.suggested_action.trim()
        : '';

    return {
        actionNeeded: rawDecision.action_needed,
        reason,
        confidence,
        requiresHumanReview,
        suggestedAction
    };
};

const parseSummaryResponse = (raw) => {
    if (!raw || typeof raw !== 'object') {
        const error = new Error('Invalid structured response from model.');
        error.code = 'OPENAI_INVALID_JSON';
        throw error;
    }

    const summary = raw.summary?.trim?.() || '';
    if (!summary) {
        const error = new Error('Model output missing summary field.');
        error.code = 'OPENAI_EMPTY_RESPONSE';
        throw error;
    }

    const type = canonicalizeEmailType(raw.type);
    const rawLabel = typeof raw.label === 'string' ? raw.label.trim() : '';
    const matched = rawLabel ? matchUserLabel(rawLabel) : null;
    const label = matched?.name || rawLabel;

    const replyDecision = parseActionDecision(raw.reply_decision);

    return { summary, type, label, replyDecision };
};

const readOpenAIConfigFromStorage = () => {
    return new Promise((resolve) => {
        chrome.storage.local.get(['openAIEndpoint', 'openAIApiKey', 'openAIModel'], (items) => {
            openAIConfig = {
                endpoint: ensureChatCompletionsPath(items.openAIEndpoint),
                apiKey: (items.openAIApiKey || '').trim(),
                model: (items.openAIModel || '').trim() || DEFAULT_SUMMARY_MODEL
            };
            openAIConfigLoaded = true;
            resolve(openAIConfig);
        });
    });
};

const getOpenAIConfig = async () => {
    if (!openAIConfigLoaded) {
        await readOpenAIConfigFromStorage();
    }
    openAIConfig.endpoint = ensureChatCompletionsPath(openAIConfig.endpoint);
    return { ...openAIConfig };
};

const isOpenAIConfigured = () => Boolean(openAIConfig.endpoint && openAIConfig.apiKey);

const ensureOpenAIConfiguration = async () => {
    const config = await getOpenAIConfig();
    if (!config.endpoint || !config.apiKey) {
        const error = new Error('OpenAI configuration missing.');
        error.code = 'MISSING_OPENAI_CONFIG';
        throw error;
    }
    return config;
};

const notifyOpenAIConfigChanged = (configured) => {
    chrome.runtime.sendMessage(
        {
            type: 'OPENAI_CONFIG_CHANGED',
            payload: { configured }
        },
        () => {
            // Ignore errors when no listeners are available.
            if (chrome.runtime.lastError) {
                return;
            }
        }
    );
};

const EMAIL_ACTION_DECISION_SCHEMA = {
    type: 'object',
    properties: {
        action_needed: {
            type: 'boolean',
            description: 'Whether this email requires user action.'
        },
        confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Model confidence for the action decision (0 to 1).'
        },
        reason: {
            type: 'string',
            minLength: 1,
            description: 'Concise explanation of the cues that led to the decision.'
        },
        suggested_action: {
            type: 'string',
            description: 'Optional recommendation for the user’s next step.'
        },
        requires_human_review: {
            type: 'boolean',
            description: 'Set true when the model is uncertain or detects conflicting signals.'
        }
    },
    required: ['action_needed', 'reason'],
    additionalProperties: false
};

const requestOpenAISummary = async (config, text, labelOptions = []) => {
    const schemaProperties = {
        type: {
            type: 'string',
            description: 'The email category type (one of predefined types).',
            enum: EMAIL_TYPE_OPTIONS
        },
        summary: {
            type: 'string',
            description: 'A concise, action-oriented summary of the email.'
        }
    };

    schemaProperties.reply_decision = {
        ...EMAIL_ACTION_DECISION_SCHEMA,
        description: 'Structured decision describing whether the user must take action.'
    };

    if (Array.isArray(labelOptions) && labelOptions.length) {
        schemaProperties.label = {
            type: 'string',
            description: 'The existing Gmail label that best matches the email.',
            enum: labelOptions
        };
    }

    const EMAIL_SUMMARY_SCHEMA = {
        name: 'email_summary',
        schema: {
            type: 'object',
            properties: schemaProperties,
            required: ['summary', 'reply_decision'],
            additionalProperties: false
        }
    };

    const labelInstructionLines = Array.isArray(labelOptions) && labelOptions.length
        ? [
            '',
            'Select the best matching Gmail label from this list:',
            labelOptions.join(', '),
            'If none apply, omit the label field.'
        ]
        : [];

    const payload = {
        model: config.model || DEFAULT_SUMMARY_MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are an assistant that classifies Gmail messages and produces concise summaries.'
            },
            {
                role: 'user',
                content: [
                    'Classify the email into one of the following types:',
                    EMAIL_TYPE_OPTIONS.join(', '),
                    '',
                    'Then summarize the message in no more than four concise sentences. Limit your response to at most 100 words in the summary.',
                    'Highlight key topics, required actions, important dates, and overall sentiment.',
                    'If the content seems truncated, summarize what is available.',
                    '',
                    'Decide whether the user must take action. Populate the reply_decision object with:',
                    '- action_needed: true when the sender expects or would meaningfully benefit from a response or other follow-up; otherwise false.',
                    '- reason: under 60 words describing the cues (requests, deadlines, tone, sender authority, etc.) that led to the decision.',
                    '- confidence: a number between 0 and 1 representing certainty in the decision.',
                    '- requires_human_review: true only when the signals are conflicting or the decision is uncertain; explain why.',
                    '- suggested_action: an optional short recommendation for what to do or say when a reply is helpful.',
                    'Prioritize precision over recall; when unsure, set requires_human_review to true instead of guessing.',
                    ...labelInstructionLines,
                    '',
                    'Keep all redacted placeholders like {{PERSON_1}} exactly as-is.',
                    '',
                    'Avoid including URLs or {{LINK}} placeholders in any part of the response; if the email mentions a link, reference it descriptively without reproducing the URL.',
                    '',
                    'Email content:',
                    text
                ].join('\n')
            }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        top_p: 0.9,
        response_format: {
            type: 'json_schema',
            json_schema: EMAIL_SUMMARY_SCHEMA
        }
    };

    let response;
    try {
        response = await fetch(config.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(payload)
        });
    } catch (networkError) {
        const error = new Error('Unable to reach the OpenAI endpoint. Check the URL and your network connection.');
        error.code = 'OPENAI_NETWORK_ERROR';
        throw error;
    }

    let responseText = '';
    try {
        responseText = await response.text();
    } catch (readError) {
        const error = new Error('Failed to read the OpenAI response.');
        error.code = 'OPENAI_ERROR';
        throw error;
    }

    let data;
    try {
        data = responseText ? JSON.parse(responseText) : null;
    } catch (parseError) {
        data = null;
    }

    if (!response.ok) {
        const detail = data?.error?.message || responseText || response.statusText;
        const error = new Error(`OpenAI request failed: ${response.status} ${detail}`.trim());
        error.code = 'OPENAI_ERROR';
        throw error;
    }

    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
        const error = new Error('OpenAI response did not include a summary.');
        error.code = 'OPENAI_EMPTY_RESPONSE';
        throw error;
    }

    let parsed;
    try {
        parsed = JSON.parse(rawContent);
    } catch (err) {
        console.warn('Failed to parse model output as JSON:', rawContent);
        parsed = { summary: rawContent };
    }

    return parsed;
};

const generateEmailSummary = async (messageId, interactive) => {
    const config = await ensureOpenAIConfiguration();
    const messageContent = await fetchMessageFromApi(messageId, interactive);
    const headers = messageContent.headers || {};

    const headerSections = [];
    if (headers.subject) {
        headerSections.push(`Subject: ${headers.subject}`);
    }
    if (headers.from) {
        headerSections.push(`From: ${headers.from}`);
    }
    if (headers.to) {
        headerSections.push(`To: ${headers.to}`);
    }
    if (headers.cc) {
        headerSections.push(`Cc: ${headers.cc}`);
    }
    if (headers.bcc) {
        headerSections.push(`Bcc: ${headers.bcc}`);
    }

    const bodyText = messageContent.plainText?.trim()
        || convertHtmlToPlainText(messageContent.htmlText);

    if (!headerSections.length && !bodyText) {
        const error = new Error('This email has no readable content.');
        error.code = 'EMPTY_EMAIL';
        throw error;
    }

    const combinedSource = [headerSections.join('\n'), bodyText].filter(Boolean).join('\n\n').trim();
    const trimmed = limitTextLength(combinedSource, MAX_SUMMARY_SOURCE_CHARS);
    let labelOptions = [];
    try {
        labelOptions = await ensureUserLabels(interactive);
    } catch (error) {
        console.warn('Failed to load user labels, continuing without label guidance:', error);
        labelOptions = [];
    }

    const { maskedText, mapping } = applyPrivacyMasking(trimmed);
    console.log('[PrivAgent] Masked email text prepared for LLM API:', maskedText);
    console.log('[PrivAgent] Mask mapping for current email:', mapping);
    const raw = await requestOpenAISummary(config, maskedText, labelOptions);
    const parsed = parseSummaryResponse(raw);
    const { text: restoredSummary, highlights: maskHighlights } = restoreMaskedText(parsed.summary, mapping);
    const { text: restoredReason } = restoreMaskedText(parsed.replyDecision.reason, mapping);
    const restoredSuggestedAction = parsed.replyDecision.suggestedAction
        ? restoreMaskedText(parsed.replyDecision.suggestedAction, mapping).text
        : '';
    const restoredReplyDecision = {
        ...parsed.replyDecision,
        reason: restoredReason,
        suggestedAction: restoredSuggestedAction
    };



    const result = {
        ...parsed,
        summary: restoredSummary,
        replyDecision: restoredReplyDecision,
        maskHighlights
    };

    return result;
};

readOpenAIConfigFromStorage();

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
        return;
    }

    let updated = false;

    if (Object.prototype.hasOwnProperty.call(changes, 'openAIEndpoint')) {
        openAIConfig.endpoint = ensureChatCompletionsPath(changes.openAIEndpoint.newValue);
        updated = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'openAIApiKey')) {
        openAIConfig.apiKey = (changes.openAIApiKey.newValue || '').trim();
        updated = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'openAIModel')) {
        const nextModel = (changes.openAIModel.newValue || '').trim();
        openAIConfig.model = nextModel || DEFAULT_SUMMARY_MODEL;
        updated = true;
    }

    if (updated) {
        openAIConfigLoaded = true;
        notifyOpenAIConfigChanged(isOpenAIConfigured());
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('PrivAgent Mail Smart Summary background ready with Gmail API scope', GMAIL_SCOPE);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) {
        return false;
    }

    if (message.type === 'FETCH_GMAIL_SUMMARY') {
        const { messageId, interactive = false } = message.payload || {};

        if (!messageId) {
            sendResponse({ success: false, error: 'Missing Gmail message ID.', code: 'INVALID_ARGUMENT' });
            return false;
        }

        generateEmailSummary(messageId, interactive)
            .then((data) => {
                sendResponse({ success: true, data });
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message || 'Failed to generate summary.', code: error.code });
            });

        return true;
    }

    if (message.type === 'CHECK_AUTH_STATUS') {
        checkAuthStatus()
            .then((authenticated) => {
                sendResponse({ success: true, authenticated });
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message || 'Unable to verify authentication.', code: error.code });
            });

        return true;
    }

    if (message.type === 'TRIGGER_INTERACTIVE_SIGNIN') {
        getAuthToken(true)
            .then(async () => {
                manualSignOut = false;
                ensureUserLabels(true, { forceRefresh: true })
                    .catch((error) => {
                        console.warn('Failed to prefetch user labels after sign-in:', error);
                    });
                sendResponse({ success: true });
                chrome.runtime.sendMessage({
                    type: 'AUTH_STATUS_CHANGED',
                    payload: { authenticated: true }
                });
            })
            .catch((error) => {
                const errorMessage = error.message || 'Sign-in failed.';
                sendResponse({
                    success: false,
                    error: errorMessage,
                    code: error.code || mapInteractiveErrorCode(errorMessage)
                });
            });

        return true;
    }

    if (message.type === 'TRIGGER_LOGOUT') {
        (async () => {
            let token;
            try {
                token = await getAuthToken(false);
            } catch (error) {
                if (error.code && error.code !== AUTH_REQUIRED_CODE) {
                    sendResponse({ success: false, error: error.message || 'Failed to sign out.', code: error.code });
                    return;
                }
                token = null;
            }

            await revokeToken(token);
            await removeCachedToken(token);
            manualSignOut = true;
            clearUserLabelCache();

            sendResponse({ success: true });
            chrome.runtime.sendMessage({
                type: 'AUTH_STATUS_CHANGED',
                payload: { authenticated: false }
            });
        })()
            .catch((error) => {
                sendResponse({ success: false, error: error.message || 'Failed to sign out.', code: error.code || 'LOGOUT_ERROR' });
            });

        return true;
    }

    if (message.type === 'CLEAR_ANONYMIZER_MEMORY') {
        try {
            if (!privacyAnonymizerReady || !runtimeGlobal?.PrivacyAnonymizer?.clearMemory) {
                sendResponse({ success: false, error: 'Anonymizer unavailable.' });
                return false;
            }
            const memoryKey = message?.payload?.memoryKey;
            runtimeGlobal.PrivacyAnonymizer.clearMemory(memoryKey);
            sendResponse({ success: true });
        } catch (error) {
            sendResponse({ success: false, error: error.message || 'Failed to clear cache.' });
        }
        return false;
    }

    if (message.type === 'APPLY_LABEL_TO_MESSAGE') {
        const { messageId, label, interactive = true } = message.payload || {};

        if (!messageId || !label) {
            sendResponse({ success: false, error: 'Missing messageId or label.' });
            return false;
        }

        assignLabelToMessage(messageId, label, interactive)
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message || 'Failed to apply label.', code: error.code });
            });

        return true;
    }

    if (message.type === 'REFRESH_USER_LABELS') {
        const { interactive = false } = message.payload || {};

        ensureUserLabels(interactive, { forceRefresh: true })
            .then((labels) => {
                sendResponse({ success: true, labels });
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message || 'Failed to refresh labels.', code: error.code });
            });

        return true;
    }

    return false;
});
