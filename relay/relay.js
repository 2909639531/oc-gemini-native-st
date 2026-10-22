'use strict';

/**
 * OC Gemini Native — 本地中转
 *
 * 作用：SillyTavern 的 MAKERSUITE 源只会把密钥塞进 URL 的 ?key=，
 *      而且不会带 x-opencode-session 头。本中转负责把这两样补齐，
 *      再把请求原样转发到 https://opencode.ai/inference/go。
 *
 * 路由：
 *   GET  /health                     健康检查
 *   POST /__config                   写入密钥/模型（内存 + 可选落盘）
 *   GET  /v1beta/models              返回模型列表（给 ST 的 status 检查用）
 *   POST /v1beta/models/{m}:{method} 转发到 OpenCode
 *
 * 不依赖任何第三方包，Node 18+ 即可运行。
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.OCG_PORT || 8899);
const HOST = process.env.OCG_HOST || '127.0.0.1';
const UPSTREAM_BASE = (
    process.env.OCG_UPSTREAM || 'https://opencode.ai/inference/go/google'
).replace(/\/$/, '');
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

const KEY_FILE = path.join(__dirname, 'key.txt');
const MODEL_FILE = path.join(__dirname, 'model.txt');
const MODELS_FILE = path.join(__dirname, 'models.txt');
const SESSION_FILE = path.join(__dirname, '.session');

const DEFAULT_MODEL = 'gemini-4-argon-contributor';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function loadSession() {
    try {
        const s = fs.readFileSync(SESSION_FILE, 'utf8').trim();
        if (/^ses_[0-9a-f]{32}$/.test(s)) return s;
    } catch {
        /* 没有就生成一个 */
    }
    const s = 'ses_' + crypto.randomBytes(16).toString('hex');
    try {
        fs.writeFileSync(SESSION_FILE, s, 'utf8');
    } catch {
        /* 落盘失败也无所谓，进程内稳定就够了 */
    }
    return s;
}

const SESSION = loadSession();

const state = {
    key: process.env.OCG_KEY || '',
    model: process.env.OCG_MODEL || DEFAULT_MODEL,
};

if (!state.key) {
    try {
        state.key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    } catch {
        /* 没有 key.txt */
    }
}
try {
    const m = fs.readFileSync(MODEL_FILE, 'utf8').trim();
    if (m) state.model = m;
} catch {
    /* 没有 model.txt */
}

function modelList() {
    try {
        const lines = fs
            .readFileSync(MODELS_FILE, 'utf8')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);
        if (lines.length) return lines;
    } catch {
        /* 没有 models.txt */
    }
    return [state.model];
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    setCors(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/* ------------------------------------------------------------------ */
/* 可选代理（CONNECT 隧道）                                             */
/* ------------------------------------------------------------------ */

function connectThroughProxy(proxyUrl, host, port) {
    return new Promise((resolve, reject) => {
        let p;
        try {
            p = new URL(proxyUrl);
        } catch (e) {
            reject(new Error(`HTTPS_PROXY 格式不对: ${proxyUrl}`));
            return;
        }
        const headers = {};
        if (p.username) {
            const auth = Buffer.from(
                `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`
            ).toString('base64');
            headers['Proxy-Authorization'] = `Basic ${auth}`;
        }
        const req = http.request({
            host: p.hostname,
            port: Number(p.port || 80),
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            timeout: 15000,
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
                return;
            }
            const tlsSocket = tls.connect({ socket, servername: host });
            tlsSocket.once('error', reject);
            tlsSocket.once('secureConnect', () => resolve(tlsSocket));
        });
        req.on('timeout', () => req.destroy(new Error('代理连接超时')));
        req.on('error', reject);
        req.end();
    });
}

/* ------------------------------------------------------------------ */
/* 转发                                                                */
/* ------------------------------------------------------------------ */

function forward(req, res, pathname, search) {
    if (!state.key) {
        sendJson(res, 400, {
            error: { code: 400, message: 'relay 里还没有密钥，先在 ST 面板点「保存并连接」，或写 key.txt' },
        });
        return;
    }

    const target = new URL(UPSTREAM_BASE + pathname + search);
    // 不要把我们自己的 key 透传给上游（上游用 Authorization 头）
    target.searchParams.delete('key');

    const headers = {
        authorization: `Bearer ${state.key}`,
        'content-type': 'application/json',
        'x-opencode-session': SESSION,
        'x-opencode-client': 'oc-gemini-native/2.0',
        'user-agent': 'opencode/1.0 (oc-gemini-native)',
        accept: target.searchParams.get('alt') === 'sse' ? 'text/event-stream' : 'application/json',
    };

    const options = {
        method: 'POST',
        host: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        headers,
        agent: false,
    };

    if (PROXY) {
        options.createConnection = (_opts, cb) => {
            connectThroughProxy(PROXY, target.hostname, 443).then(
                socket => cb(null, socket),
                err => cb(err)
            );
        };
    }

    const started = Date.now();
    const upReq = https.request(options, upRes => {
        const keep = ['content-type', 'content-encoding', 'cache-control'];
        const outHeaders = {};
        for (const k of keep) {
            if (upRes.headers[k]) outHeaders[k] = upRes.headers[k];
        }
        setCors(res);
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
        upRes.on('end', () => {
            const ms = Date.now() - started;
            console.log(`  <- ${upRes.statusCode} ${pathname} ${ms}ms`);
        });
    });

    upReq.on('error', err => {
        console.error('  !! 上游请求失败:', err.message);
        if (!res.headersSent) {
            sendJson(res, 502, { error: { code: 502, message: `relay 转发失败: ${err.message}` } });
        } else {
            res.end();
        }
    });

    req.pipe(upReq);
    req.on('aborted', () => upReq.destroy());
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = u.pathname;

    if (req.method === 'OPTIONS') {
        setCors(res);
        res.writeHead(204);
        res.end();
        return;
    }

    if (pathname === '/health') {
        sendJson(res, 200, {
            ok: true,
            hasKey: !!state.key,
            model: state.model,
            session: SESSION,
            upstream: UPSTREAM_BASE,
            proxy: PROXY || null,
        });
        return;
    }

    if (pathname === '/__config' && req.method === 'POST') {
        try {
            const raw = await readBody(req);
            const body = JSON.parse(raw || '{}');
            if (typeof body.key === 'string') state.key = body.key.trim();
            if (typeof body.model === 'string' && body.model.trim()) state.model = body.model.trim();
            console.log(`  ** 配置更新: model=${state.model} hasKey=${!!state.key}`);
            sendJson(res, 200, { ok: true, model: state.model, hasKey: !!state.key });
        } catch (e) {
            sendJson(res, 400, { error: { code: 400, message: e.message } });
        }
        return;
    }

    // 模型列表：给 ST 的 status 检查用
    if (pathname.endsWith('/models') && req.method === 'GET') {
        const models = modelList().map(id => ({
            name: `models/${id}`,
            displayName: id,
            description: 'opencode go',
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
            inputTokenLimit: 1048576,
            outputTokenLimit: 65535,
        }));
        sendJson(res, 200, { models });
        return;
    }

    // 生成：/v1beta/models/{model}:generateContent 或 :streamGenerateContent
    if (pathname.includes(':') && req.method === 'POST') {
        console.log(`  -> ${pathname}${u.search ? ' ' + u.search.replace(/key=[^&]*/, 'key=***') : ''}`);
        forward(req, res, pathname, u.search);
        return;
    }

    sendJson(res, 404, { error: { code: 404, message: `未知路由 ${req.method} ${pathname}` } });
});

server.listen(PORT, HOST, () => {
    const line = '='.repeat(58);
    console.log(line);
    console.log('  OC Gemini Native — 本地中转已启动');
    console.log(line);
    console.log(`  监听地址 : http://${HOST}:${PORT}`);
    console.log(`  上游     : ${UPSTREAM_BASE}`);
    console.log(`  模型     : ${state.model}`);
    console.log(`  密钥     : ${state.key ? '已配置 (' + state.key.slice(0, 12) + '…)' : '未配置 —— 去 ST 面板填，或写 key.txt'}`);
    console.log(`  会话 ID  : ${SESSION}`);
    console.log(`  代理     : ${PROXY || '直连'}`);
    console.log(line);
    console.log('  保持这个窗口开着。关掉就等于断开。');
    console.log('');
});

process.on('SIGINT', () => {
    console.log('\n中转已停止。');
    process.exit(0);
});
