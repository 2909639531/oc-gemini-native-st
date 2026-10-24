#!/usr/bin/env node
/**
 * OC Gemini Native — ST 后端补丁应用器
 *
 * 用途：SillyTavern 升级 / 重装 / 换成官方包之后，后端补丁会丢失，插件里
 *       「OpenCodeGo G4A 专属（ST）」会变成 OpenCode 返回 401/404。跑一次本脚本即可补回。
 *
 * 用法：
 *   node apply-backend-patch.js                       # 从脚本自身位置向上推断酒馆根目录
 *   node apply-backend-patch.js "D:\path\to\SillyTavern"
 *   node apply-backend-patch.js "D:\path\SillyTavern" --check   # 只检查是否已打补丁
 *
 * 特性：
 *   - 自带 unified diff 解析，不依赖 git / patch 命令
 *   - 幂等：已打过直接退出 0
 *   - 打之前自动备份为 chat-completions.js.backup-ocg-<时间戳>
 *   - 打完自动跑 node --check 做语法校验，失败则回滚
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REL_TARGET = path.join('src', 'endpoints', 'backends', 'chat-completions.js');
const PATCH_FILE = path.join(__dirname, 'ocg-backend.patch');
const MARKER = 'isOcgGeminiRequest';

/**
 * 本脚本通常放在 <ST>/public/scripts/extensions/third-party/oc-gemini-native-st/ 里，
 * 也可能被复制到酒馆根目录。两种情况都尝试推断，找不到再让用户手动传参。
 * @returns {string|null} 酒馆根目录
 */
function detectStRoot() {
    const candidates = [
        path.resolve(__dirname, '..', '..', '..', '..', '..'), // 扩展目录内部
        path.resolve(__dirname),                                // 已被复制到根目录
    ];

    for (const dir of candidates) {
        const pkg = path.join(dir, 'package.json');
        const target = path.join(dir, REL_TARGET);
        if (!fs.existsSync(pkg) || !fs.existsSync(target)) continue;
        try {
            const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
            if (String(json.name || '').toLowerCase().includes('sillytavern')) return dir;
        } catch { /* 继续下一个候选 */ }
    }

    return null;
}

function log(...args) {
    console.log('[ocg-patch]', ...args);
}

function fail(message) {
    console.error('[ocg-patch] 失败：' + message);
    process.exit(1);
}

/** 解析 unified diff，返回 [{ oldStart, lines: [{type, text}] }] */
function parsePatch(patchText) {
    const lines = patchText.split(/\r?\n/);
    const hunks = [];
    let current = null;

    for (const line of lines) {
        const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
        if (header) {
            current = { oldStart: Number(header[1]), lines: [] };
            hunks.push(current);
            continue;
        }
        if (!current) continue;
        if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
        if (line.startsWith('\\')) continue;
        if (line === '') continue;

        const type = line[0];
        const text = line.slice(1);
        if (type === ' ' || type === '-' || type === '+') {
            current.lines.push({ type, text });
        }
    }

    return hunks;
}

/** 在期望位置附近寻找完全匹配的旧块，返回实际行号（0-based），找不到返回 -1 */
function locate(fileLines, expectedIndex, oldBlock) {
    if (oldBlock.length === 0) return expectedIndex;

    const matches = (start) => {
        if (start < 0 || start + oldBlock.length > fileLines.length) return false;
        for (let i = 0; i < oldBlock.length; i++) {
            if (fileLines[start + i] !== oldBlock[i]) return false;
        }
        return true;
    };

    if (matches(expectedIndex)) return expectedIndex;

    const maxDrift = 400;
    for (let drift = 1; drift <= maxDrift; drift++) {
        if (matches(expectedIndex - drift)) return expectedIndex - drift;
        if (matches(expectedIndex + drift)) return expectedIndex + drift;
    }
    return -1;
}

function main() {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const explicitRoot = args.find(arg => !arg.startsWith('--'));
    const stRoot = explicitRoot ? path.resolve(explicitRoot) : detectStRoot();

    if (!stRoot) {
        fail('无法自动推断酒馆根目录。\n'
            + '   请显式传参：node apply-backend-patch.js "D:\\path\\to\\SillyTavern"');
    }

    const target = path.join(stRoot, REL_TARGET);
    log('酒馆根目录：' + stRoot);

    if (!fs.existsSync(target)) fail(`找不到目标文件：${target}\n   请把 SillyTavern 根目录作为参数传入。`);
    if (!fs.existsSync(PATCH_FILE)) fail(`找不到补丁文件：${PATCH_FILE}`);

    const original = fs.readFileSync(target, 'utf8');

    if (original.includes(MARKER)) {
        log('目标文件已包含 OpenCode Gemini 补丁，无需重复应用。');
        log('安装位置：' + target);
        process.exit(0);
    }

    if (checkOnly) {
        fail('目标文件尚未打补丁。去掉 --check 重新运行以应用。');
    }

    const patchText = fs.readFileSync(PATCH_FILE, 'utf8');
    const hunks = parsePatch(patchText);
    if (!hunks.length) fail('补丁文件里没有解析到任何 hunk。');

    const fileLines = original.split(/\r?\n/);
    const result = [];
    let cursor = 0;
    let shift = 0;

    for (const hunk of hunks) {
        const oldBlock = hunk.lines.filter(l => l.type !== '+').map(l => l.text);
        const newBlock = hunk.lines.filter(l => l.type !== '-').map(l => l.text);
        const expected = hunk.oldStart - 1 + shift;
        const actual = locate(fileLines, expected, oldBlock);

        if (actual < 0) {
            fail(`第 ${hunk.oldStart} 行附近的补丁块匹配不上，说明目标文件版本不一致。\n`
                + '   这通常是因为 SillyTavern 已升级到新版本，需要按新版源码重新核对补丁。');
        }

        result.push(...fileLines.slice(cursor, actual));
        result.push(...newBlock);
        cursor = actual + oldBlock.length;
        shift = actual - (hunk.oldStart - 1);
    }

    result.push(...fileLines.slice(cursor));

    const patched = result.join('\n');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = `${target}.backup-ocg-${stamp}`;
    fs.copyFileSync(target, backup);
    log('已备份原文件：' + backup);

    fs.writeFileSync(target, patched, 'utf8');
    log('补丁已写入：' + target);

    try {
        execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
        log('语法校验通过。请重启 SillyTavern 生效。');
    } catch (error) {
        fs.copyFileSync(backup, target);
        const detail = (error.stderr || error.stdout || '').toString().trim();
        fail('语法校验未通过，已回滚原文件。\n' + detail);
    }
}

main();
