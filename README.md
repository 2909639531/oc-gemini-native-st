# OC Gemini Native (ST)

让 OpenCode Go 的 `gemini-4-argon-contributor` 在原版 SillyTavern 里走 **Gemini 原生协议**。

同一套请求模型跟 TauriTavern 版一致：`custom` 源 + `gemini_generate_content`。
**没有中转进程。**

> ⚠️ **这个扩展必须配一个后端补丁才能用。** 只装扩展是不够的 —— 原因见下面「问题到底在哪」。
> 没打补丁时，扩展启动会弹红色提示，面板里也会出现红框警示。

---

## 问题到底在哪（为什么不能只靠扩展）

OpenCode 的 Gemini 只活在 Gemini 原生端点上：

```
https://opencode.ai/inference/go/google/v1beta/models/{model}:generateContent
https://opencode.ai/inference/go/google/v1beta/models/{model}:streamGenerateContent?alt=sse
```

用 OpenAI 兼容端点请求会 400 `Model does not support this protocol.`（模型和协议绑死）。
除 `Authorization: Bearer oc_sk_...` 外还强制要求 `x-opencode-session: ses_<32hex>`，
缺失时比鉴权更早，直接 400 `MissingSessionID`。

TauriTavern 版能只靠一个扩展，是因为 **TT 前端原生认识** `custom_api_format = 'gemini_generate_content'`。
上游 SillyTavern 1.19.0 没有这个机制，而且缺口全在后端：

| # | 缺口 | 具体位置 |
|---|---|---|
| 1 | 前端根本不发 `custom_api_format` | `public/scripts/openai.js` 零命中；`settingsToGenerateData` 的 CUSTOM 分支只塞 `custom_url` / `custom_include_headers` / `custom_include_body` / `custom_exclude_body` |
| 2 | 前端只认 OpenAI 形状的流 | `getStreamingReply()` 里 CUSTOM 分支读 `data.choices[0].delta.content`；Gemini 形状只有 MAKERSUITE/VERTEXAI 分支才解析 → 直通就是界面不出字 |
| 3 | status 探测会打 `{custom_url}/models` | 后端 `/api/backends/chat-completions/status` 的 CUSTOM 分支真去 GET；OpenCode 没这个接口 → 永远红点「无连接…」 |

所以后端必须补一个文件：`src/endpoints/backends/chat-completions.js`。

---

## 装

### 方式一：从 Git 直接装（推荐）

在 SillyTavern 里：**扩展程序 → 安装扩展 → 填入本仓库地址**：

```
https://github.com/2909639531/oc-gemini-native-st
```

装完之后**还差一步**：打后端补丁。仓库里带了补丁文件和应用器，直接执行：

```bash
# 在酒馆根目录执行（脚本会自动向上找酒馆根目录，也可以显式传路径）
node public/scripts/extensions/third-party/oc-gemini-native-st/apply-backend-patch.cjs
```

看到 `语法校验通过。请重启 SillyTavern 生效。` 就成了，然后**重启酒馆**、刷新页面。

### 方式二：手动复制

1. 把整个文件夹放到 `<SillyTavern>\public\scripts\extensions\third-party\`
2. 同上，跑一次 `apply-backend-patch.cjs`
3. 重启酒馆

### 连起来

1. 「聊天补全来源」选 **OpenCodeGo G4A 专属（ST）**
2. 面板里粘 `oc_sk_...`，点「保存」
3. 状态变绿「有效的」→ 可以聊天

---

## 补丁做了什么（`ocg-backend.patch`）

只改 `src/endpoints/backends/chat-completions.js` 一个文件，9 处：

1. **请求判定** `isOcgGeminiRequest()`：`source === custom` 且满足任一 ——
   `custom_api_format === 'gemini_generate_content'` / `custom_include_headers` 含 `x-ocg-gemini:` / `custom_url` 主机是 `opencode.ai`
2. **路由**：`/generate` 的 `switch` 前拦下，转进现成的 Gemini 转换器
3. **鉴权**：key 取 `SECRET_KEYS.CUSTOM`，走 `Authorization: Bearer`，URL **不带 `?key=`**
4. **请求头**：补 `x-opencode-session`（缺则用 HMAC 生成）、`x-opencode-client`、`user-agent`
5. **SSE 翻译** `streamOcgGeminiAsOpenAI()`：`parts[].thought` → `delta.reasoning_content`，正文 → `delta.content`，结尾补 `finish_reason` + `[DONE]`
6. **系统提示词**：custom 源永远不发 `use_sysprompt`，OCG 强制走 `systemInstruction`，否则角色卡设定会被降级成一条 user 消息
7. **stop 序列**：Gemini 最多 5 条且拒空串，OCG 分支过滤截断
8. **status 兜底**：直接返回 `{ data: [{ id: model }], bypass: true }`
9. **早失败**：fetch 后立刻判 `!ok` 并透传状态码，401 不再被 `.json()` 吞掉

应用器 `apply-backend-patch.cjs`：自带 unified diff 解析（不依赖 git / patch 命令）、
幂等、自动备份为 `chat-completions.js.backup-ocg-<时间戳>`、打完 `node --check`，失败自动回滚。

> 酒馆升级或重装后补丁会丢，重跑一次应用器即可。换大版本可能对不上，
> 应用器会明确报「匹配不上」而不是乱改。

---

## 扩展本身做了什么

| 动作 | 说明 |
|---|---|
| 下拉框插入同层选项 | `data-ocg`，`value="custom"`，插在原「自定义」之前 |
| 改配置 | 启用时才写 `custom_url` / `custom_model` / `custom_include_headers`，并留 `backup` 快照 |
| 生成前重写 payload | `CHAT_COMPLETION_SETTINGS_READY` 里补 `custom_api_format` 和 session 头 |
| 写密钥 | `POST /api/secrets/write` → `api_key_custom`，设置里只留 `hasKey` 布尔 |
| 启动自检 | 探测后端补丁是否存在，缺了就红框报警 + 弹提示 |
| 启动自动连接 | ST 载入后 `online_status` 恒为 `no_connection`，不点「连接」输入框就写着「未连接到 API！」，这里替用户点一次 |
| 退出还原 | 关掉开关会写回 `backup` 里的原始配置 |

`x-opencode-session` 由 `chatId + characterId + 名字 + 群组` 做 FNV-1a 哈希生成
（`ses_` + 32 位 hex），同一角色同一段对话恒定 → 上游 prompt 缓存命中率更高。

---

## 已知限制

- 只在 **SillyTavern 1.19.0** 上验证过
- OpenCode 没有 Gemini 模型列表接口，「可用模型」只有当前一个
- 思考过程以 `reasoning_content` 给出，需要开「显示思考」
- 单次生成常见 60~120 秒

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板红框「后端补丁未应用」 | 只装了扩展 | 跑 `apply-backend-patch.cjs`，重启酒馆 |
| 一直红点「无连接…」 | 同上 | 同上 |
| 401 / `Go requires a credential` | 密钥错、已吊销，或补丁没生效 | 重填密钥；`--check` 确认补丁 |
| 不报错但一个字不出 | 流式翻译没生效 | 重跑应用器；看后端控制台有没有 `OpenCode Gemini stream interrupted` |
| `MissingSessionID` | session 头被覆盖 | 检查 `custom_include_headers` 是否被别的预设清掉 |

检查补丁状态：

```bash
node public/scripts/extensions/third-party/oc-gemini-native-st/apply-backend-patch.cjs --check
```

---

## 版本

- **3.0.0** —— 改为 TT 同款 `custom + gemini_generate_content`，去掉 relay；
  密钥归到 `api_key_custom`；新增后端补丁探测/报警、启动自动连接、`systemInstruction` 修正
- 2.0.0 —— `makersuite` + `reverse_proxy` + 本地 relay（已废弃）
