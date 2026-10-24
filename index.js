'use strict';

/**
 * OC Gemini Native — SillyTavern 版
 * v3.0.0
 *
 * ════════════════════════════════════════════════════════════════════
 * 一、这个扩展要解决什么问题
 * ════════════════════════════════════════════════════════════════════
 *
 * OpenCode Go（opencode.ai）里的 gemini-4-argon-contributor 只活在
 * Gemini 原生协议端点上：
 *
 *     https://opencode.ai/inference/go/google/v1beta/models/{model}:generateContent
 *     https://opencode.ai/inference/go/google/v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * 用 OpenAI 兼容端点（/chat/completions）请求它会直接 400
 * "Model does not support this protocol."——模型和协议是绑死的。
 *
 * 而且除了 Authorization: Bearer oc_sk_... 之外，还强制要求一个
 * x-opencode-session: ses_<32位小写hex> 请求头，缺失时比鉴权还早，
 * 直接 400 MissingSessionID。
 *
 * ════════════════════════════════════════════════════════════════════
 * 二、为什么 TauriTavern 版能只靠一个扩展，ST 版不行
 * ════════════════════════════════════════════════════════════════════
 *
 * TT 版的做法是：chat_completion_source = custom，同时给出
 * custom_api_format = 'gemini_generate_content'。TT 的前端**原生**
 * 认识这个字段，会把 custom 源当 Gemini 用。
 *
 * 但上游 SillyTavern 1.19.0 完全没有这个机制，具体三个缺口：
 *
 *  缺口 1（请求侧）
 *    public/scripts/openai.js 里 "custom_api_format" 零命中。
 *    settingsToGenerateData 的 CUSTOM 分支只塞 custom_url /
 *    custom_include_headers / custom_include_body / custom_exclude_body。
 *    → 扩展往 generateData 里写这个字段也没用，ST 不会转发给后端。
 *
 *  缺口 2（响应侧）
 *    openai.js 的 getStreamingReply() 里，CUSTOM 分支读的是
 *    data.choices[0].delta.content（OpenAI 形状）。Gemini 形状
 *    （candidates[0].content.parts[].text）只有 MAKERSUITE/VERTEXAI
 *    分支才解析。
 *    → 把 Gemini SSE 直通给前端，界面上不会出任何字。
 *
 *  缺口 3（状态侧）
 *    后端 /api/backends/chat-completions/status 的 CUSTOM 分支会真的去
 *    GET {custom_url}/models。OpenCode 没有这个接口。
 *    → 界面永远红点「无连接…」，连带输入框显示「未连接到 API！」。
 *
 * 结论：这三件事都发生在后端，前端扩展无论如何补不上。
 * 所以 ST 版必须配一个后端补丁（只改一个文件）：
 *
 *     src/endpoints/backends/chat-completions.js
 *
 * 补丁内容见仓库根目录 ocg-backend.patch，应用器 apply-backend-patch.js。
 * 没打补丁时，本扩展会在启动时探测并弹出明确提示（见 probeBackendPatch）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 三、v3.0.0 相对 v2.0.0 改了什么
 * ════════════════════════════════════════════════════════════════════
 *
 *  v2（已废弃）：makersuite 源 + reverse_proxy 指向本地 relay 进程，
 *               由 relay 补 Authorization 和 x-opencode-session。
 *               问题：必须常驻一个中转进程；密钥一度落进 extensionSettings；
 *               makersuite 会弹「Connecting To Proxy」确认框；备份/还原
 *               漏掉反代相关字段，退出后界面残留「未连接」。
 *
 *  v3（当前）：和 TT 同一套请求模型 —— custom + gemini_generate_content。
 *             没有中转进程。密钥只存在 ST 的 secrets.json（api_key_custom）。
 *             具体改动：
 *               1. 去掉 relay 依赖与 makersuite/reverse_proxy 的全部逻辑
 *               2. 密钥改为一次性 POST /api/secrets/write 写入后端，
 *                  设置里只留 hasKey 布尔，不再保存明文
 *               3. 备份/还原的字段表补齐 custom_api_format / reverse_proxy 等
 *               4. 每次生成前由 CHAT_COMPLETION_SETTINGS_READY 事件重写 payload
 *               5. 启动时探测后端补丁是否已应用，未应用则明确报警
 *               6. 启动时替用户点一次「连接」，否则 ST 载入后 online_status
 *                  恒为 no_connection，输入框一直显示「未连接到 API！」
 *
 * 选中「OpenCodeGo G4A 专属（ST）」后：
 *   - chat_completion_source = custom
 *   - custom_api_format = gemini_generate_content
 *   - custom_url / custom_model 自动写入
 *   - 密钥写入 ST 的 CUSTOM secret（api_key_custom）
 *   - 每次生成前注入 x-opencode-session
 */

const MODULE_NAME = 'oc-gemini-native-st';
const LOG_PREFIX = '[OC Gemini Native ST]';
const OCG_LABEL = 'OpenCodeGo G4A 专属（ST）';

const DEFAULT_SETTINGS = {
    enabled: false,
    hasKey: false,
    baseUrl: 'https://opencode.ai/inference/go/google',
    model: 'gemini-4-argon-contributor',
    spoofUserAgent: true,
    userAgent: 'opencode/1.0 (oc-gemini-native)',
    fakeStatus: true,
    thinkingLevel: '',
    backup: null,
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (s[key] === undefined || s[key] === null) s[key] = DEFAULT_SETTINGS[key];
    }
    return s;
}

function persistSettings() {
    try {
        SillyTavern.getContext().saveSettingsDebounced();
    } catch (e) {
        console.warn(LOG_PREFIX, 'settings save failed', e);
    }
}

function getOai() {
    try {
        return SillyTavern.getContext().chatCompletionSettings || null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* session id                                                          */
/* ------------------------------------------------------------------ */

function fnv32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function buildSessionId() {
    let ctx = {};
    try {
        ctx = SillyTavern.getContext();
    } catch {
        ctx = {};
    }
    const seed = [ctx.chatId || '', ctx.characterId ?? '', ctx.name2 || '', ctx.groupId || ''].join('|');
    const hex =
        fnv32(seed, 0x811c9dc5) +
        fnv32(seed, 0x01000193) +
        fnv32(seed + '#1', 0x9e3779b9) +
        fnv32(seed + '#2', 0x85ebca6b);
    return 'ses_' + hex.slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* headers                                                             */
/* ------------------------------------------------------------------ */

function yamlScalar(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function toHeaderYaml(headers) {
    return Object.entries(headers)
        .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
        .join('\n');
}

/**
 * 构造非敏感请求头。
 * Authorization 由 ST 后端从 api_key_custom 读取并注入，不会落进
 * settings.json / presets.json，也不会出现在扩展设置里。
 */
function buildHeaders() {
    const s = getSettings();
    const headers = {
        'x-opencode-session': buildSessionId(),
        'x-opencode-client': 'oc-gemini-native/3.0',
    };
    if (s.spoofUserAgent) headers['user-agent'] = s.userAgent;
    return headers;
}

/* ------------------------------------------------------------------ */
/* secret                                                              */
/* ------------------------------------------------------------------ */

async function writeCustomSecret(key) {
    if (!key) return false;
    try {
        const headers =
            typeof getRequestHeaders === 'function'
                ? getRequestHeaders()
                : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/secrets/write', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key: 'api_key_custom', value: key }),
        });
        if (!res.ok) {
            console.warn(LOG_PREFIX, 'secret write rejected', res.status);
            return false;
        }
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'secret write failed', e);
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* backup / restore                                                    */
/* ------------------------------------------------------------------ */

const BACKUP_KEYS = [
    'chat_completion_source',
    'custom_api_format',
    'custom_url',
    'custom_model',
    'custom_include_headers',
    'reverse_proxy',
    'proxy_password',
    'google_model',
];

function snapshotCustomConfig(oai) {
    const snap = {};
    for (const k of BACKUP_KEYS) snap[k] = oai[k];
    return snap;
}

function restoreCustomConfig(oai, snap) {
    if (!oai || !snap) return;
    for (const k of BACKUP_KEYS) {
        if (snap[k] !== undefined) oai[k] = snap[k];
    }
}

/* ------------------------------------------------------------------ */
/* apply / release                                                     */
/* ------------------------------------------------------------------ */

function applyOcgConfig() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;
    oai.chat_completion_source = 'custom';
    oai.custom_api_format = 'gemini_generate_content';
    oai.custom_url = s.baseUrl;
    oai.custom_model = s.model;
    oai.custom_include_headers = toHeaderYaml(buildHeaders());
    persistSettings();
}

async function enterOcgMode() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;

    if (!s.enabled) {
        // 只在「从关闭切到开启」时备份一次，避免重启后被自己的配置覆盖
        s.backup = snapshotCustomConfig(oai);
        s.enabled = true;
        console.debug(LOG_PREFIX, 'snapshot saved', s.backup);
    }

    applyOcgConfig();
    updateOcgPanel(true);
    setTimeout(syncUiFields, 50);
    console.debug(LOG_PREFIX, 'entered OCG mode', { model: s.model, hasKey: s.hasKey });
}

function leaveOcgMode() {
    const s = getSettings();
    const oai = getOai();
    s.enabled = false;
    if (oai && s.backup) {
        restoreCustomConfig(oai, s.backup);
        console.debug(LOG_PREFIX, 'original custom config restored');
        s.backup = null;
        persistSettings();
    }
    updateOcgPanel(false);
}

function restoreNow() {
    const s = getSettings();
    const oai = getOai();
    if (oai && s.backup) {
        restoreCustomConfig(oai, s.backup);
        s.backup = null;
        s.enabled = false;
        persistSettings();
        syncUiFields();
        updateOcgPanel(false);
        toastr.success('已还原接管前的自定义配置，扩展已停用', OCG_LABEL);
    } else {
        toastr.info('没有可还原的备份', OCG_LABEL);
    }
}

/** 让 ST 自己的输入框也显示正确的值，避免界面看起来是空的。 */
function syncUiFields() {
    const s = getSettings();
    const map = {
        '#custom_api_url_text': s.baseUrl,
        '#custom_model_id': s.model,
    };
    for (const [sel, val] of Object.entries(map)) {
        const $el = $(sel);
        if (!$el.length) {
            console.debug(LOG_PREFIX, 'ui field not found:', sel);
            continue;
        }
        $el.val(val);
    }
}

/* ------------------------------------------------------------------ */
/* payload rewrite                                                     */
/* ------------------------------------------------------------------ */

function onChatCompletionSettingsReady(generateData) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    try {
        generateData.chat_completion_source = 'custom';
        generateData.custom_api_format = 'gemini_generate_content';
        generateData.custom_url = settings.baseUrl;
        generateData.model = settings.model;
        generateData.custom_model = settings.model;
        generateData.custom_include_headers = toHeaderYaml(buildHeaders());

        // 思考档位：只有用户显式选了才动，默认完全交给宿主
        if (settings.thinkingLevel) {
            generateData.reasoning_effort = settings.thinkingLevel;
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'rewrite failed', e);
    }
}

/* ------------------------------------------------------------------ */
/* status / model list fallback                                        */
/* ------------------------------------------------------------------ */

function buildFakeModelsPayload() {
    const model = getSettings().model;
    const entry = {
        name: `models/${model}`,
        displayName: model,
        description: 'opencode go',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65535,
    };
    // 同时给 Gemini 与 OpenAI 两种形状，哪个解析器都能吃下
    return { models: [entry], data: [{ id: model, object: 'model', owned_by: 'opencode' }] };
}

function installStatusFallback() {
    if (window.__ocGeminiNativeFetchPatched) return;
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return;
    window.__ocGeminiNativeFetchPatched = true;
    // 后端补丁探测要用没被劫持的原始 fetch（下面会把 /status 换成假响应）
    window.__ocgOriginalFetch = originalFetch;

    window.fetch = async function (input, init) {
        let url = '';
        try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch {
            url = '';
        }

        const s = getSettings();
        const isStatus =
            url.includes('chat-completions/status') ||
            url.includes('chat_completion_status') ||
            url.includes('chat-completions/models');

        if (!isStatus || !s.enabled || !s.fakeStatus) {
            return originalFetch.apply(this, arguments);
        }

        console.debug(LOG_PREFIX, 'status request intercepted:', url);
        return new Response(JSON.stringify(buildFakeModelsPayload()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
}

/* ------------------------------------------------------------------ */
/* backend patch probe                                                 */
/* ------------------------------------------------------------------ */

/**
 * 判断后端补丁是否已应用。
 *
 * 办法：用**未被劫持**的原始 fetch 打一次 /status（就是「缺口 3」那个接口）。
 *   - 已打补丁 → OCG 分支直接返回 { data: [...], bypass: true }
 *   - 未打补丁 → 真去 GET opencode.ai/.../models，404，返回 { error: true, ... }
 * 不需要额外加路由，也不会消耗 token。
 *
 * @returns {Promise<boolean>} true = 补丁在
 */
async function probeBackendPatch() {
    const fetchFn = window.__ocgOriginalFetch || window.fetch;
    const { getRequestHeaders } = SillyTavern.getContext();

    try {
        const res = await fetchFn('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: getSettings().baseUrl,
                custom_model: getSettings().model,
                model: getSettings().model,
            }),
        });

        if (!res.ok) return false;
        const data = await res.json();
        return data?.bypass === true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'backend probe failed', e);
        return false;
    }
}

/**
 * 补丁缺失时的提示。这是「从 Git 装了扩展却没打补丁」唯一的可见反馈，
 * 没有它用户只会看到 401 或界面不出字，完全不知道该做什么。
 */
function warnMissingBackendPatch() {
    const el = document.getElementById('ocg_patch_warning');
    if (el) el.style.display = '';

    toastr.error(
        '后端补丁未应用：扩展装好了，但酒馆后端还不认识 Gemini 协议。<br>'
        + '请在酒馆根目录执行：<br><code>node apply-backend-patch.js</code><br>'
        + '（补丁文件 ocg-backend.patch 在本扩展目录里）',
        'OC Gemini Native — 还差一步',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

function clearBackendPatchWarning() {
    const el = document.getElementById('ocg_patch_warning');
    if (el) el.style.display = 'none';
}

/* ------------------------------------------------------------------ */
/* generation timer                                                    */
/* ------------------------------------------------------------------ */

let genTimer = null;
let genStart = 0;

function startGenTimer() {
    if (genTimer) return;
    genStart = Date.now();
    genTimer = setInterval(() => {
        const sec = ((Date.now() - genStart) / 1000).toFixed(0);
        $('#ocg_status_line').text(`生成中… ${sec}s`);
    }, 500);
}

function stopGenTimer() {
    if (!genTimer) return;
    clearInterval(genTimer);
    genTimer = null;
    const sec = ((Date.now() - genStart) / 1000).toFixed(1);
    $('#ocg_status_line').text(`上次生成 ${sec}s`);
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 在「聊天补全来源」下拉框里插入同层选项（插在原有 custom 之前）。 */
function installSourceOption() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return false;
    if ($select.find('option[data-ocg]').length) return true;

    const $opt = $(`<option value="custom" data-ocg="1">${OCG_LABEL}</option>`);
    const $original = $select.find('option[value="custom"]').first();
    if ($original.length) {
        // 插在前面：任何 .val('custom') 都会命中我们，避免视觉跳回原选项
        $original.before($opt);
    } else {
        $select.append($opt);
    }
    console.debug(LOG_PREFIX, 'source option installed');
    return true;
}

function isOcgSelected() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return false;
    const opt = el.options[el.selectedIndex];
    return !!(opt && opt.dataset && opt.dataset.ocg);
}

function selectOcgOption() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return;
    for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].dataset && el.options[i].dataset.ocg) {
            el.selectedIndex = i;
            return;
        }
    }
}

function renderOcgPanel() {
    if ($('#ocg_panel').length) return;
    const s = getSettings();
    const html = `
    <div id="ocg_panel" class="ocg-panel" style="display:none;">
      <div class="ocg-panel-title">${OCG_LABEL}</div>
      <label for="ocg_key_input">OCG 密钥</label>
      <div class="ocg-key-row">
        <input type="password" id="ocg_key_input" class="text_pole" placeholder="${s.hasKey ? '已保存在 ST 后端，留空则不修改' : 'oc_sk_...'}" value="">
        <div id="ocg_key_status" class="menu_button">保存</div>
      </div>
      <label for="ocg_model_input">模型 ID</label>
      <input type="text" id="ocg_model_input" class="text_pole" value="${escapeHtml(s.model)}">
      <label for="ocg_thinking">思考档位</label>
      <select id="ocg_thinking" class="text_pole">
        <option value="">不干预（默认，推荐）</option>
        <option value="low">low — 省 token，最快</option>
        <option value="medium">medium — 折中</option>
        <option value="high">high — 想得最久，最贵</option>
      </select>
      <div class="ocg-actions">
        <div id="ocg_restore" class="menu_button">还原原始配置</div>
      </div>
      <div id="ocg_status_line" class="ocg-hint">${s.hasKey ? '密钥已保存在 ST 后端' : ''}</div>
      <div id="ocg_patch_warning" class="ocg-patch-warning" style="display:none">
        <b>后端补丁未应用</b><br>
        扩展已装好，但酒馆后端还不认识 Gemini 协议，发消息会报 401 或界面不出字。<br>
        在酒馆根目录跑一次：<code>node apply-backend-patch.js</code><br>
        （<code>apply-backend-patch.js</code> 和 <code>ocg-backend.patch</code> 就在本扩展目录里，把它复制到酒馆根目录再执行即可。）
      </div>
      <small class="ocg-hint">不用启动中转。请求直接由 ST 后端发往 OpenCode，密钥保存在 ST 的 CUSTOM secret 中。</small>
    </div>`;
    $('#chat_completion_source').closest('div').after(html);

    $('#ocg_model_input').on('input', function () {
        getSettings().model = String(this.value).trim() || DEFAULT_SETTINGS.model;
        persistSettings();
        if (getSettings().enabled) applyOcgConfig();
    });
    $('#ocg_thinking').val(s.thinkingLevel || '').on('change', function () {
        getSettings().thinkingLevel = String(this.value);
        persistSettings();
        console.debug(LOG_PREFIX, 'thinkingLevel =', getSettings().thinkingLevel || '(不干预)');
    });
    $('#ocg_restore').on('click', restoreNow);
    $('#ocg_key_status').on('click', async function () {
        const key = String($('#ocg_key_input').val() || '').trim();
        if (!key) {
            toastr.warning(getSettings().hasKey ? '密钥已保存；要更换请先输入新密钥' : '密钥为空', OCG_LABEL);
            return;
        }
        const ok = await writeCustomSecret(key);
        if (ok) {
            const s = getSettings();
            s.hasKey = true;
            s.enabled = true;
            persistSettings();
            applyOcgConfig();
            $('#ocg_key_input').val('');
            $('#ocg_key_input').attr('placeholder', '已保存在 ST 后端，留空则不修改');
            $('#ocg_status_line').text('密钥已保存在 ST 后端');
        }
        toastr[ok ? 'success' : 'error'](ok ? '密钥已写入，可以开始聊天' : '密钥写入失败，看控制台', OCG_LABEL);

        // 存完密钥立刻验证后端补丁，避免用户填完密钥还是发不出去却不知道原因
        if (ok) {
            if (await probeBackendPatch()) clearBackendPatchWarning();
            else warnMissingBackendPatch();
        }
    });
}

function updateOcgPanel(on) {
    $('#ocg_panel').toggle(!!on);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function bindSourceSelect() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return;

    $select.on('change.ocg', function () {
        const on = isOcgSelected();
        // 等 ST 自己的 change 处理完再接管，避免被它覆盖
        setTimeout(() => {
            if (on) enterOcgMode();
            else leaveOcgMode();
        }, 0);
    });
}

/**
 * ST 载入后 online_status 默认是 no_connection，而它只会在用户点「连接」时探测一次。
 * 结果就是每次开页输入框都写着「未连接到 API！」、发送按钮被隐藏。
 * 这里替用户点一次，探测由扩展的 status 兜底负责，必然是绿的。
 */
function autoConnectOnce() {
    if (window.__ocgAutoConnected) return;
    window.__ocgAutoConnected = true;

    const trigger = () => {
        if (!getSettings().enabled) return;
        if (!isOcgSelected()) return;
        $('#api_button_openai').trigger('click');
    };

    // 延后一点，等 ST 自己的绑定和配置恢复都完成
    setTimeout(trigger, 700);
    // 万一第一次被 ST 的初始化盖掉，再补一次
    setTimeout(() => {
        if (!isOcgSelected()) return;
        if ($('#send_form').hasClass('no-connection')) trigger();
    }, 3000);
}

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();

    installStatusFallback();
    renderOcgPanel();

    if (event_types) {
        const hook = (name, fn) => {
            if (event_types[name]) eventSource.on(event_types[name], fn);
        };
        hook('GENERATION_STARTED', startGenTimer);
        hook('GENERATION_ENDED', stopGenTimer);
        hook('GENERATION_STOPPED', stopGenTimer);
    }

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (installSourceOption() || tries > 40) {
            clearInterval(timer);
            bindSourceSelect();

            const s = getSettings();
            if (s.enabled) {
                // 恢复上次的接管状态：把选中项拨回我们，再重放一次配置
                selectOcgOption();
                applyOcgConfig();
                updateOcgPanel(true);
                setTimeout(syncUiFields, 100);
                // 宿主可能在我们之后再还原一次选中项，补一刀
                setTimeout(selectOcgOption, 1500);
                // ST 载入后不会自己探测连接，输入框会一直显示「未连接到 API！」，
                // 发送按钮也被隐藏。这里替用户点一次「连接」，否则每次开页都要手点。
                autoConnectOnce();
                // 从 Git 装的扩展拿不到后端补丁，这里明确告诉用户还差哪一步
                setTimeout(async () => {
                    if (await probeBackendPatch()) clearBackendPatchWarning();
                    else warnMissingBackendPatch();
                }, 1200);
            }
            console.log(`${LOG_PREFIX} v3.0.0 ready — enabled=${s.enabled} model=${s.model} hasKey=${s.hasKey}`);
        }
    }, 250);

    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
});
