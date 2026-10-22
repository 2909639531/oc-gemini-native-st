# 本地中转（relay）

一个零依赖的 Node 脚本，把 SillyTavern 的 Gemini 请求补上 OpenCode 要的两个头再转发出去。

## 为什么需要它

SillyTavern 的 Google AI Studio（makersuite）源只会把密钥塞进 URL 的 `?key=`，
而且**不会**带 `x-opencode-session`。OpenCode 两个都认不上，于是：

- 不带 `Authorization` → 401 `Invalid credential`
- 不带 `x-opencode-session` → 400 `MissingSessionID`（而且这个检查在鉴权之前）

中转负责补齐。

## 跑

双击 `start-relay.bat`（启动中转）。

需要 Node.js 20 以上。窗口里出现这些就对了：

```
==========================================================
  OC Gemini Native — 本地中转已启动
==========================================================
  监听地址 : http://127.0.0.1:8899
  上游     : https://opencode.ai/inference/go/google
  模型     : gemini-4-argon-contributor
  密钥     : 未配置 —— 去 ST 面板填，或写 key.txt
  会话 ID  : ses_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  代理     : 直连
==========================================================
```

或者命令行：`node relay.js`

## 配置

优先级：**环境变量 > 文本文件 > 默认值**

| 环境变量 | 文件 | 默认 | 说明 |
|---|---|---|---|
| `OCG_PORT` | — | `8899` | 监听端口，改了要同步改 ST 面板里的中转地址 |
| `OCG_KEY` | `key.txt` | 空 | 密钥；也可以在 ST 面板点「保存并连接」送进来 |
| `OCG_MODEL` | `model.txt` | `gemini-4-argon-contributor` | 默认模型 |
| — | `models.txt` | 单行 | 每行一个模型 ID，用于扩充 `/v1beta/models` 返回的列表 |
| `OCG_UPSTREAM` | — | `https://opencode.ai/inference/go/google` | 上游地址 |
| `HTTPS_PROXY` | — | 空 | 走代理时填，例如 `http://127.0.0.1:7890` |

`key.txt` 和 `model.txt` 是可选的。只用 ST 面板配置就不需要建。

`.session` 是自动生成的会话 ID，删掉会重新生成一个（不删更好，缓存命中率更稳）。

## 走代理

```bat
set HTTPS_PROXY=http://127.0.0.1:7890
node relay.js
```

中转会用 `CONNECT` 隧道连出去，支持带用户名密码的代理。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, hasKey, model, session, upstream, proxy}` |
| POST | `/__config` | body `{key, model}`，写进内存 |
| GET | `/v1beta/models` | 返回 `{models:[{name, displayName, supportedGenerationMethods, ...}]}` |
| POST | `/v1beta/models/{model}:generateContent` | 转发 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | 转发，SSE 流式 |

所有响应都带 `Access-Control-Allow-Origin: *`，因为 ST 的页面和中转不同源。

## 安全

- 只监听 `127.0.0.1`，外网访问不到
- 密钥只存在内存里（除非你自己写 `key.txt`）
- 转发的 URL 会先把 `?key=` 摘掉，不会把密钥透传给上游
- 日志里密钥只显示前 12 位

## 日志长这样

```
  -> /v1beta/models/gemini-4-argon-contributor:streamGenerateContent ?alt=sse&key=***
  <- 200 /v1beta/models/gemini-4-argon-contributor:streamGenerateContent 86923ms
```

`<-` 后面的状态码就是上游返回的。401 是密钥问题，400 是缺头，200 就是通了。
