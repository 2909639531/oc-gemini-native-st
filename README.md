# OC Gemini Native（SillyTavern 版）

让 **OpenCode Go** 的 `gemini-4-argon-contributor` 在**原版 SillyTavern** 里跑起来，走 **Gemini 原生 `generateContent` 协议**。

> **只支持原版 SillyTavern**（Node 版）。
> TauriTavern 请用 [oc-gemini-native-TT](https://github.com/2909639531/oc-gemini-native-TT)，那个不需要中转。
>
> 状态：**Beta**。转发链路已实测，但尚未在真机 SillyTavern 上跑过完整对话。

---

## 为什么不能照搬 TT 版

上游 SillyTavern 1.19.0 的「自定义」源只有 `Custom (OpenAI-compatible)` 一种，
源码里**根本没有** `custom_api_format` 这个字段（`openai.js` 和 `index.html` 都是零命中），
后端 CUSTOM 分支也只拼 OpenAI 兼容的 `messages` 请求体。

唯一能说 Gemini 原生协议的口子是 **MAKERSUITE**（Google AI Studio），它支持 `reverse_proxy`，
设置反代后密钥取 `proxy_password`，请求拼成：

```
{reverse_proxy}/v1beta/models/{model}:streamGenerateContent?key=...
```

于是本方案长这样：

```
SillyTavern ──makersuite + 反代──> 127.0.0.1:8899 (relay) ──补两个头──> opencode.ai
```

中转要补的两个头是 `Authorization: Bearer <key>` 和 `x-opencode-session`——ST 自己不会加。
（顺带一提：ST 只用 `?key=` 传密钥，OpenCode 不认这个。）

---

## 安装

### 第一步：扩展

在 SillyTavern 的「扩展」界面点 **Install extension**，地址填：

```
https://github.com/2909639531/oc-gemini-native-st
```

或者手动把仓库放进：

```
<SillyTavern 目录>\public\scripts\extensions\third-party\oc-gemini-native-st\
```

### 第二步：启动中转

1. 确认装了 **Node.js 20+**（`node -v` 能出版本号）
2. 双击扩展目录里的 `relay/start-relay.bat`
3. 窗口里出现「本地中转已启动」就对了，**这个窗口要一直开着**

### 第三步：连起来

1. 刷新 SillyTavern 页面
2. 「聊天补全来源」里选 **OpenCodeGo G4A 专属（ST）**
3. 面板里粘 `oc_sk_...` 密钥，点「保存并连接」
4. 看到「已连接 · 模型 gemini-4-argon-contributor」就可以聊天了

---

## 密钥存在哪

**不存进 SillyTavern 的任何配置文件。**

- 点「保存并连接」时，密钥通过 `POST /__config` 送进中转的**内存**
- ST 侧只记地址和模型名，`proxy_password` 留空
- 中转重启后密钥丢失 → 回 ST 面板再点一次即可

---

## 中转做了什么

| 路由 | 作用 |
|---|---|
| `GET /health` | 健康检查，返回是否已配密钥 |
| `POST /__config` | 写入密钥 / 模型（内存） |
| `GET /v1beta/models` | 返回模型列表，供 ST 的 status 检查用 |
| `POST /v1beta/models/{m}:generateContent` | 转发到 OpenCode |
| `POST /v1beta/models/{m}:streamGenerateContent` | 同上，SSE 流式原样回传 |

转发时会自动把 `?key=` 从 URL 摘掉（改用 Authorization 头），并加上稳定的
`x-opencode-session`（`ses_` + 32 位 hex，存于 `relay/.session`，重启不变，有利于 prompt 缓存）。

配置项、代理设置、日志格式见 [`relay/README.md`](relay/README.md)。

---

## 已知限制

- **必须开中转**。中转一关，ST 直接报错
- ST 第一次设置反代时可能弹一次「Connecting To Proxy」确认框，勾「不再询问」即可
- 模型列表只有一项（OpenCode 没有可用的 Gemini 列表接口），可在 `relay/models.txt` 里手写多行扩充
- 只在 ST 1.19.0 的源码结构上验证过；更老的版本若 `reverse_proxy` 不支持 makersuite 会失效
- 单次生成常见 60~150 秒

---

## 排错

**ST 里报错连不上**
1. 中转窗口还开着吗
2. 浏览器访问 `http://127.0.0.1:8899/health` 有没有 JSON
3. 面板点「检测中转」

**能连上但一发消息就 401**
密钥错了或被吊销。中转窗口里会打印 `<- 401`。

**ST 控制台报 `Failed to get chat completions status`**
中转没起来，ST 拿不到模型列表。启动中转后刷新页面。

---

## 版本

- 2.0.0 —— 初版，makersuite + reverse_proxy + 本地中转
