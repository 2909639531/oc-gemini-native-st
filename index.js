'use strict';

/**
 * OC Gemini Native — SillyTavern 版
 * v2.0.0
 *
 * 为什么不能照搬 TT 版：
 *   上游 SillyTavern 的「自定义」源只有 OpenAI 兼容一种协议，没有 custom_api_format，
 *   也没有 Gemini generateContent 分支。想让 ST 说 Gemini 原生协议，唯一可用的口子是
 *   MAKERSUITE（Google AI Studio）源：它支持 reverse_proxy，且设置反代后
 *   apiKey 取 proxy_password，请求拼成
 *       {reverse_proxy}/v1beta/models/{model}:{streamGenerateContent|generateContent}?key=...
 *
 * 于是本扩展做两件事：
 *   1. 把 ST 切到 makersuite + reverse_proxy = 本地中转（默认 http://127.0.0.1:8899）
 *   2. 中转（relay.js）负责补 Authorization: Bearer 和 x-opencode-session，
 *      再转发到 https://opencode.ai/inference/go
 *
 * 密钥不进 ST 的任何配置文件：只通过 POST /__config 存进 relay 的内存。
 */

const MODULE_NAME = 'oc-gemini-native-st';
const LOG_PREFIX = '[OC Gemini Native ST]';
const OCG_LABEL = 'OpenCodeGo G4A 专属（ST）';

const DEFAULT_SETTINGS = {
    enabled: false,
    apiKey: '',
    relayUrl: 'http://127.0.0.1:8899',
    model: 'gemini-4-argon-contributor',
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
/* backup / restore                                                    */
/* ------------------------------------------------------------------ */

const BACKUP_KEYS = ['chat_completion_source', 'reverse_proxy', 'proxy_password', 'google_model'];

function snapshotConfig(oai) {
    const snap = {};
    for (const k of BACKUP_KEYS) snap[k] = oai[k];
    return snap;
}

function restoreConfig(oai, snap) {
    if (!oai || !snap) return;
    for (const k of BACKUP_KEYS) {
        if (snap[k] !== undefined) oai[k] = snap[k];
    }
}

/* ------------------------------------------------------------------ */
/* relay 通讯                                                          */
/* ------------------------------------------------------------------ */

async function relayFetch(pathname, init) {
    const s = getSettings();
    const url = String(s.relayUrl).replace(/\/$/, '') + pathname;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`relay ${pathname} -> HTTP ${res.status}`);
    return res;
}

async function pushConfigToRelay() {
    const s = getSettings();
    const res = await relayFetch('/__config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: s.apiKey, model: s.model }),
    });
    return res.json();
}

async function pingRelay() {
    const res = await relayFetch('/health', { method: 'GET' });
    return res.json();
}

/* ------------------------------------------------------------------ */
/* apply / release                                                     */
/* ------------------------------------------------------------------ */

function applyOcgConfig() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;

    oai.chat_completion_source = 'makersuite';
    oai.reverse_proxy = s.relayUrl;
    // 密钥由 relay 持有，ST 这边留空，避免明文落进 settings.json / presets.json
    oai.proxy_password = '';
    oai.google_model = s.model;
    persistSettings();
    setTimeout(syncUiFields, 50);
}

async function enterOcgMode() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;

    if (!s.enabled) {
        s.backup = snapshotConfig(oai);
        s.enabled = true;
        console.debug(LOG_PREFIX, 'snapshot saved', s.backup);
    }

    applyOcgConfig();
    updateOcgPanel(true);

    if (s.apiKey) {
        try {
            const r = await pushConfigToRelay();
            console.debug(LOG_PREFIX, 'relay configured', r);
        } catch (e) {
            console.warn(LOG_PREFIX, 'relay not reachable', e);
            toastr.warning('本地中转没启动，先双击 relay/start-relay.bat', OCG_LABEL);
        }
    }
}

function leaveOcgMode() {
    const s = getSettings();
    const oai = getOai();
    s.enabled = false;
    if (oai && s.backup) {
        restoreConfig(oai, s.backup);
        console.debug(LOG_PREFIX, 'original config restored');
        s.backup = null;
        persistSettings();
    }
    updateOcgPanel(false);
}

function restoreNow() {
    const s = getSettings();
    const oai = getOai();
    if (oai && s.backup) {
        restoreConfig(oai, s.backup);
        s.backup = null;
        s.enabled = false;
        persistSettings();
        syncUiFields();
        updateOcgPanel(false);
        toastr.success('已还原接管前的配置，扩展已停用', OCG_LABEL);
    } else {
        toastr.info('没有可还原的备份', OCG_LABEL);
    }
}

function syncUiFields() {
    const s = getSettings();
    const map = {
        '#openai_reverse_proxy': s.relayUrl,
        '#openai_proxy_access_key': '',
    };
    for (const [sel, val] of Object.entries(map)) {
        const $el = $(sel);
        if (!$el.length) {
            console.debug(LOG_PREFIX, 'ui field not found:', sel);
            continue;
        }
        $el.val(val);
    }
    const $model = $('#model_google_select');
    if ($model.length) $model.val(s.model);
}

/* ------------------------------------------------------------------ */
/* payload rewrite                                                     */
/* ------------------------------------------------------------------ */

function onChatCompletionSettingsReady(generateData) {
    const s = getSettings();
    if (!s.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    try {
        generateData.chat_completion_source = 'makersuite';
        generateData.model = s.model;
        generateData.google_model = s.model;
        generateData.reverse_proxy = s.relayUrl;
        generateData.proxy_password = '';
    } catch (e) {
        console.error(LOG_PREFIX, 'rewrite failed', e);
    }
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

function installSourceOption() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return false;
    if ($select.find('option[data-ocg]').length) return true;

    const $opt = $(`<option value="makersuite" data-ocg="1">${OCG_LABEL}</option>`);
    const $original = $select.find('option[value="makersuite"]').first();
    if ($original.length) {
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
      <label for="ocg_relay_input">本地中转地址</label>
      <input type="text" id="ocg_relay_input" class="text_pole" value="${escapeHtml(s.relayUrl)}">
      <label for="ocg_key_input">OCG 密钥（只存在中转里，不写进 ST 配置）</label>
      <div class="ocg-key-row">
        <input type="text" id="ocg_key_input" class="text_pole" placeholder="oc_sk_..." value="${escapeHtml(s.apiKey)}">
        <div id="ocg_key_status" class="menu_button">保存并连接</div>
      </div>
      <label for="ocg_model_input">模型 ID</label>
      <input type="text" id="ocg_model_input" class="text_pole" value="${escapeHtml(s.model)}">
      <div class="ocg-actions">
        <div id="ocg_ping" class="menu_button">检测中转</div>
        <div id="ocg_restore" class="menu_button">还原原始配置</div>
      </div>
      <div id="ocg_status_line" class="ocg-hint"></div>
      <small class="ocg-hint">需要先启动 <code>relay/start-relay.bat</code>。中转负责补 Authorization 与 x-opencode-session 头。</small>
    </div>`;
    $('#chat_completion_source').closest('div').after(html);

    $('#ocg_relay_input').on('input', function () {
        getSettings().relayUrl = String(this.value).trim() || DEFAULT_SETTINGS.relayUrl;
        persistSettings();
    });
    $('#ocg_key_input').on('input', function () {
        getSettings().apiKey = String(this.value).trim();
        persistSettings();
    });
    $('#ocg_model_input').on('input', function () {
        getSettings().model = String(this.value).trim() || DEFAULT_SETTINGS.model;
        persistSettings();
        if (getSettings().enabled) applyOcgConfig();
    });
    $('#ocg_restore').on('click', restoreNow);

    $('#ocg_ping').on('click', async function () {
        const $line = $('#ocg_status_line').text('检测中…');
        try {
            const r = await pingRelay();
            $line.text(`中转在线 · 密钥${r.hasKey ? '已配置' : '未配置'} · 模型 ${r.model}`);
            toastr.success('中转在线', OCG_LABEL);
        } catch (e) {
            $line.text('中转没响应');
            toastr.error('中转没响应，先双击 relay/start-relay.bat', OCG_LABEL);
        }
    });

    $('#ocg_key_status').on('click', async function () {
        const key = String($('#ocg_key_input').val() || '').trim();
        getSettings().apiKey = key;
        persistSettings();
        if (!key) {
            toastr.warning('密钥为空', OCG_LABEL);
            return;
        }
        try {
            const r = await pushConfigToRelay();
            applyOcgConfig();
            $('#ocg_status_line').text(`已连接 · 模型 ${r.model}`);
            toastr.success('密钥已送达中转，可以开始聊天', OCG_LABEL);
        } catch (e) {
            console.warn(LOG_PREFIX, e);
            toastr.error('连不上本地中转，先启动 relay/start-relay.bat', OCG_LABEL);
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
        setTimeout(() => {
            if (on) enterOcgMode();
            else leaveOcgMode();
        }, 0);
    });
}

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();

    renderOcgPanel();

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (installSourceOption() || tries > 40) {
            clearInterval(timer);
            bindSourceSelect();

            const s = getSettings();
            if (s.enabled && !s.apiKey) {
                s.enabled = false;
                persistSettings();
            }
            if (s.enabled) {
                selectOcgOption();
                applyOcgConfig();
                updateOcgPanel(true);
                setTimeout(selectOcgOption, 1500);
                if (s.apiKey) {
                    pushConfigToRelay().catch(e => console.warn(LOG_PREFIX, 'relay not reachable', e));
                }
            }
            console.log(`${LOG_PREFIX} v2.0.0 ready — enabled=${s.enabled} model=${s.model} relay=${s.relayUrl}`);
        }
    }, 250);

    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
});
