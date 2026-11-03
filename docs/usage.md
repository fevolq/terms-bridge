# terms-bridge 使用说明

适用版本：`@fevolq/terms-bridge@0.1.0`。功能概览见[插件说明](../README.md)。

## 安装插件

需要 Node.js 22+；dsh 已验证版本为 `0.2.1-rc.2`。

### 从源码构建

从 GitHub 下载或克隆源码后，在包含 `package.json` 的仓库根目录执行：

```powershell
npm ci
npm test
npm pack
```

`npm ci` 按锁文件安装依赖；`npm test` 构建并运行测试；`npm pack` 重新构建并生成 `fevolq-terms-bridge-0.1.0.tgz`。安装包包含运行所需依赖，可复制到其他机器安装。

源码目录：`src/` 为插件后端，`client/` 为设置页面，`tests/` 为测试，`examples/` 为项目接入示例，`scripts/` 为构建脚本。`dist/`、`node_modules/` 和打包产物不提交到 Git。

原生 dsh 集成测试需要将环境变量 `DSH_TEST_PACKAGE` 设置为本机 dsh 的 `package.json` 绝对路径，未设置时跳过。测试使用临时配置和模拟模型。Python 示例及其集成测试需要 Python 3.10+；未找到 Python 时跳过相应测试，插件本身不依赖 Python。

### 安装构建好的包

在发布包所在目录执行，以下使用 Web profile：

```powershell
dsh plugin --profile web add ./fevolq-terms-bridge-0.1.0.tgz --ignore-scripts
```

安装或升级插件后，重新加载插件或重启对应的 dsh 实例。每个 profile 只启用一个 terms-bridge 实例。

示例使用项目 ID `news`、dsh 地址 `http://127.0.0.1:3080`、项目服务地址 `http://127.0.0.1:8001`。跨机器使用时替换为双方实际可访问的地址。

## 1. 在 dsh 中新增项目

进入 **设置 → 项目接入 → 新增项目**：

| 配置 | 示例值 |
| --- | --- |
| 项目 ID | `news`，在插件内必须唯一 |
| 项目名称 | `新闻业务`，仅用于显示，允许重复 |
| 工作区路径 | 留空，自动创建；手动填写时目录必须已存在，且不能与其他项目共用 |
| 模型 | 从当前 dsh 的模型列表选择 |
| Agent 预设 | 默认选中当前 dsh 默认预设，或手动选择其他预设 |
| 权限模式 | 按业务选择；生成文件通常需要工作区内修改权限 |
| 最大并发 | 例如 `3`；留空或 `0` 不限制 |
| 结果回调地址 | `http://127.0.0.1:8001/api/dsh/results` |
| 请求令牌 | 本例留空 |
| 回调请求头 | 本例留空 |

点击 **保存配置**，新增项目即可接收任务，无需重启 dsh。任务使用 dsh 及选定预设中可用的技能。

工作区路径留空时，使用 dsh 默认工作区同级目录下以项目 ID 命名的文件夹，不存在时自动创建；手动填写时使用已有目录。保存后，页面显示项目实际使用的完整路径。

项目 ID 和工作区路径保存后不可修改。已有任务（含排队及重试任务）沿用接收时的模型、预设、权限、回调和重试配置；并发限额使用当前配置，在「并发与超时」中调整。

移除项目要执行 **移除项目 → 确认移除 → 保存配置**，有未完成任务时保存会被拒绝。工作区、文件和会话均保留。

若配置应用失败，插件保留原配置并暂停接收新任务，具体原因见插件日志。

### 权限与凭证

- 请求令牌选填，直接填写实际值；配置后，请求插件时发送 `Authorization: Bearer <令牌>`。
- 回调请求头填写 JSON 对象。请求令牌不会被自动用于回调，两者独立配置。
- 已设置的请求令牌在页面中隐藏；保存其他字段不会将其清除。更换时输入新值，清除时点击「清除令牌」，然后保存。
- 权限模式包括「仅可查看」「工作区内修改」「自动审查」「完全权限」，默认「工作区内修改」。
- 自动审查需要 dsh 提供对应权限预设；不可用时任务失败，不自动放宽权限。人工审批仍遵循 dsh 的权限机制。
- 会话权限仍受操作系统的文件权限限制。

## 2. 项目实现回调和结果下载

下面是可独立运行的最小接收端。安装 `fastapi uvicorn httpx`，保存为 `receiver.py`：

```python
from pathlib import Path
import re

import httpx
from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
API = "http://127.0.0.1:3080/api/terms-bridge"
PROJECT_ID = "news"
OUTPUT = Path(__file__).resolve().parent / "downloads"

# 请求插件时使用。只有在项目设置了请求令牌时才需要填写。
REQUEST_HEADERS = {}  # 例如 {"Authorization": "Bearer example-request-token"}
# 与插件的“回调请求头（JSON）”保持一致；默认不校验自定义请求头。
CALLBACK_HEADERS = {}  # 例如 {"X-Bridge-Key": "example-callback-key"}


@app.post("/api/dsh/results")
async def webhook(payload: dict, request: Request):
    for name, value in CALLBACK_HEADERS.items():
        if request.headers.get(name) != value:
            raise HTTPException(401, "回调请求头不匹配")
    if payload["metadata"]["project_id"] != PROJECT_ID:
        raise HTTPException(404, "项目不匹配")

    print("任务：", payload["metadata"]["task_id"])
    print("最终回复：", payload["result"])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=120) as client:
        for file in payload["files"]:
            file_id = file["file_id"]
            if not re.fullmatch(r"file_[a-f0-9]{32}", file_id):
                raise HTTPException(400, "无效的 file_id")
            response = await client.get(
                f"{API}/projects/{PROJECT_ID}/files/{file_id}",
                headers=REQUEST_HEADERS,
            )
            response.raise_for_status()
            suffix = Path(file["filename"]).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
                suffix = ""
            target = OUTPUT / (file_id + suffix)
            target.write_bytes(response.content)
            print("已保存：", target)
    return {"ok": True}
```

在接收端目录执行：

```powershell
python -m pip install fastapi uvicorn httpx
python -m uvicorn receiver:app --host 127.0.0.1 --port 8001
```

需要供另一台机器访问时，改成相应的监听地址，并将 dsh 中的回调地址改为可访问的地址。

该接收端在全部文件下载并保存后才返回 200；下载异常会返回非 2xx，由插件重试。重复回调使用相同文件 ID，覆盖同一份文件。`files: []` 时只处理文本，仍正常返回成功。若一次回调耗时超过默认 10 秒，在项目配置中增加「单次回调超时」。

## 3. 上传文件并提交任务（PowerShell）

接收端运行后，另开终端。将 `C:/images/reference.png` 替换为实际图片路径：

```powershell
$api = 'http://127.0.0.1:3080/api/terms-bridge'
$projectId = 'news'
$headers = @{}
# 启用请求令牌时取消下一行注释，并填入实际值：
# $headers.Authorization = 'Bearer example-request-token'
$curlHeaders = @()
if ($headers.ContainsKey('Authorization')) {
    $curlHeaders = @('-H', "Authorization: $($headers.Authorization)")
}

$uploadedJson = curl.exe @curlHeaders -sS --fail-with-body -F 'file=@C:/images/reference.png;type=image/png' "$api/projects/$projectId/files"
if ($LASTEXITCODE -ne 0) { throw '文件上传失败' }
$uploaded = $uploadedJson | ConvertFrom-Json
$taskId = [guid]::NewGuid().ToString('N')
$task = @{
    metadata = @{ project_id = $projectId; task_id = $taskId }
    instruction = "请分析 @$($uploaded.file_id) 中的内容，并给出结论。"
    files = @(@{ file_id = $uploaded.file_id })
} | ConvertTo-Json -Depth 5

Write-Host "任务 ID: $taskId"
Invoke-RestMethod -Method Post -Uri "$api/tasks" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($task))
Invoke-RestMethod -Uri "$api/projects/$projectId/tasks/$taskId" -Headers $headers
```

上传只需要项目 ID，不需要任务 ID。上例上传 PNG；其他格式需同步调整 `type=` 的值，例如 JPEG 使用 `image/jpeg`。上传成功返回 `file_id`、插件生成的 `filename`、文件大小、SHA-256 等信息。文件名使用 `<秒级时间戳>_<随机6个字符>.<扩展名>`，例如 `1793318400_a7B3xQ.png`。

每个新任务使用新的任务 ID。如果提交时网络超时，不代表任务未被接收；先查询原任务 ID，必要时用同一任务 ID 和完全相同的内容重发，避免生成重复业务任务。

### 多文件与提示词引用

逐个上传文件，将返回的 ID 同时放入 `files` 和提示词：

```json
{
  "metadata": {"project_id": "news", "task_id": "task-002"},
  "instruction": "给 @file_9751f0e64617464da9982a381269698b 中的人物穿上 @file_2b67ffb86bb548a884ac61e7a1484551 中的衣服",
  "files": [
    {"file_id": "file_9751f0e64617464da9982a381269698b"},
    {"file_id": "file_2b67ffb86bb548a884ac61e7a1484551"}
  ]
}
```

示例 ID 必须替换为实际上传返回的 ID。引用使用完整 `@file_id`，两侧需为空白或文本边界；插件按 ID 匹配，不依赖数组顺序，同一 ID 可以在提示词中出现多次，但 `files` 中每个 ID 只声明一次。未在 `files` 中声明的 ID 会保留原文。附件即使没有在提示词中被引用，也会传入会话。

纯文本任务直接填写提示词，使用 `files: []`。`metadata` 只包含 `project_id` 和 `task_id`；模型和权限使用项目配置。

## 4. 完整流程脚本（Python）

下面的脚本调用插件 API，完成一次图片上传、任务提交和轮询；结果文件由第 2 节的接收端下载。它只依赖 `httpx`，保存为 `run_flow.py`，修改文件路径与提示词后执行 `python run_flow.py`。

```python
from pathlib import Path
import mimetypes
import time
import uuid

import httpx

API = "http://127.0.0.1:3080/api/terms-bridge"
PROJECT_ID = "news"
HEADERS = {}  # 启用请求令牌时填写 Authorization: Bearer <实际值>
SOURCE = Path("C:/images/reference.png")

with httpx.Client(headers=HEADERS, timeout=120) as client:
    media_type = mimetypes.guess_type(SOURCE.name)[0] or "application/octet-stream"
    with SOURCE.open("rb") as source:
        response = client.post(
            f"{API}/projects/{PROJECT_ID}/files",
            files={"file": (SOURCE.name, source, media_type)},
        )
    response.raise_for_status()
    file_id = response.json()["file_id"]
    task_id = uuid.uuid4().hex
    print("文件 ID：", file_id)
    print("任务 ID：", task_id)
    payload = {
        "metadata": {"project_id": PROJECT_ID, "task_id": task_id},
        "instruction": f"请分析 @{file_id} 中的内容，并给出结论。",
        "files": [{"file_id": file_id}],
    }
    response = client.post(f"{API}/tasks", json=payload)
    response.raise_for_status()

    for _ in range(600):
        response = client.get(f"{API}/projects/{PROJECT_ID}/tasks/{task_id}")
        response.raise_for_status()
        task = response.json()
        status = task["status"]
        delivery = task["delivery"]["status"]
        print("执行：", status, "回调：", delivery)
        if status == "failed":
            raise RuntimeError(task["execution"]["last_error"])
        if delivery == "failed":
            raise RuntimeError(f"回调失败：{task['delivery']['last_error']}；结果仍可通过查询和下载接口获取")
        if status == "completed" and delivery == "delivered":
            print(task["result"])
            print("结果文件数：", len(task["files"]))
            break
        time.sleep(3)
    else:
        raise TimeoutError(f"等待任务 {task_id} 超时，可继续查询该任务 ID")
```

任务完成与回调成功是两个状态。只需要执行结果时，`status == completed` 即可读取 `result` 和 `files`；需要确认接收端处理完成时，继续等待 `delivery.status == delivered`。上例每 3 秒查询一次，最多 600 次；轮询超时不会取消插件中的任务。

若会话被删除，查询返回 `404 / SESSION_NOT_FOUND`，结束该任务的轮询。不要因回调尚未完成而重新提交一个新任务。

## 5. 回调内容与主动下载

回调示例：

```json
{
  "metadata": {"project_id": "news", "task_id": "task-002"},
  "result": "处理完成。\n\n[结果](output.png)",
  "files": [
    {
      "file_id": "file_abcdef0123456789abcdef0123456789",
      "project_id": "news",
      "filename": "1793318400_a7B3xQ.png",
      "media_type": "application/octet-stream",
      "size": 123,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "created_at": "2026-10-30T00:00:00.000Z"
    }
  ]
}
```

`result` 是 AI 最终回复原文，不含工具响应或推理内容，可以是空字符串。`files` 是插件收集并保存的结果文件列表，可以为空数组；收集范围见下文。下载时使用 `files[].file_id`，无需解析 `result` 中的链接或访问 dsh 主机的磁盘路径。

查询到完成结果后，也可以主动下载第一个文件。下面接着使用第 3 节的变量：

```powershell
$state = Invoke-RestMethod -Uri "$api/projects/$projectId/tasks/$taskId" -Headers $headers
if ($state.status -ne 'completed') { throw '任务尚未完成' }
if ($state.files.Count -gt 0) {
    $file = $state.files[0]
    $destination = Join-Path (Get-Location).Path $file.filename
    Invoke-WebRequest -Uri "$api/projects/$projectId/files/$($file.file_id)" -Headers $headers -OutFile $destination
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
        throw '下载文件校验失败'
    }
    Write-Host "已保存: $destination"
}
```

结果文件支持最终回复中的 Markdown 链接、图片、行内代码和原生附件，也支持本轮通过 dsh `present` 工具声明的文件卡片。文件卡片无需再次写入最终回复的文本。普通路径和文件卡片指向的文件必须位于项目工作区内，同一路径只收集一次；普通工具日志中的路径和历史回合的文件卡片不会被收集。

本回合通过 `present` 声明的文件均视为交付物，包括 AI 主动交付的中间稿。

插件先保存独立副本再发回调，原文件后续修改不影响已发布副本；不会继续解析文件内容中的其他引用。

## 6. 随包示例

| 文件 | 用途 |
| --- | --- |
| [task.json](../examples/task.json) | 纯文本任务请求 |
| [result-file-task.json](../examples/result-file-task.json) | 请求生成文件并在最终回复引用它 |
| [project_client.py](../examples/project_client.py) | 标准库提交、查询及 SQLite 回调接收示例 |
| [upload_and_submit.py](../examples/upload_and_submit.py) | 先上传再提交，并保存请求 JSON，便于按原内容重发 |
| [download_result.py](../examples/download_result.py) | 按文件 ID 下载并校验大小和 SHA-256 |

这些 Python 示例需要 Python 3.10+，不属于插件运行依赖。业务项目可以使用任意语言实现同样的 HTTP 协议。

标准库示例用法，在插件源码或包含 `examples` 的目录运行：

```powershell
$env:DSH_API_BASE = 'http://127.0.0.1:3080/api/terms-bridge'
# 若设置了请求令牌，客户端环境变量填写实际值：
# $env:DSH_REQUEST_TOKEN = 'example-request-token'
python examples/project_client.py serve --project-id news --port 8001
```

另开终端设置同样的 API 地址和可选令牌，再执行：

```powershell
$env:DSH_API_BASE = 'http://127.0.0.1:3080/api/terms-bridge'
python examples/upload_and_submit.py news task-003 ./input.png --instruction '请分析附件中的内容。' --out ./task-003.json
python examples/project_client.py query news task-003
python examples/download_result.py news file_abcdef0123456789abcdef0123456789 --out ./output.png
```

下载命令里的文件 ID 换成实际结果；目标文件必须不存在。`project_client.py serve` 保存回调 JSON，但不会自动下载文件，可按需使用下载示例。它与第 2 节接收端二选一，不能同时占用 8001 端口；启用自定义回调头时，使用 `DSH_CALLBACK_HEADERS` 环境变量传入对应 JSON。

`upload_and_submit.py` 的提示词原样提交，上例通过附件使用文件；若要在提示词指定位置使用 `@file_id`，先上传取得 ID，再参照第 3、4 节构造请求。

## 7. 接口参考

以下路径均位于配置的 API 前缀下，默认是 `/api/terms-bridge`。未设置请求令牌时不发送鉴权头；设置后四个接口都要求 `Authorization: Bearer <令牌>`，它与 dsh 页面登录凭证不同。

插件复用 dsh 的 HTTP 服务，不单独监听端口。API 前缀可在「项目接入 → 接口设置」中调整。

| 方法 | 路径（省略前缀） | 用途 |
| --- | --- | --- |
| POST | `/projects/{project_id}/files` | 上传输入文件 |
| POST | `/tasks` | 提交任务 |
| GET | `/projects/{project_id}/tasks/{task_id}` | 查询执行状态、回调状态及完成结果 |
| GET | `/projects/{project_id}/files/{file_id}` | 下载输入文件或结果文件 |

### 上传：POST /projects/{project_id}/files

使用未压缩的 `multipart/form-data`，且仅有一个名为 `file` 的文件字段，不附带任务 ID。成功返回 `201`，响应体是文件元数据：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `file_id` | string | `file_` 加 32 位小写十六进制字符，用于引用与下载 |
| `project_id` | string | 文件所属项目 |
| `filename` | string | 插件生成的文件名，不是上传的原始名称 |
| `media_type` | string | MIME 类型；无法确定时为 `application/octet-stream` |
| `size` | integer | 字节数 |
| `sha256` | string | 内容 SHA-256，小写十六进制 |
| `created_at` | string | UTC ISO 8601 时间 |

单文件最大 50 MiB；每项目最多同时上传 2 个文件，全局 8 个，超出返回 `429`，可稍后重试。上传传输超时 120 秒。上传中断或校验失败不会发布文件 ID。

### 提交：POST /tasks

`Content-Type: application/json` 或 `application/json; charset=utf-8`，使用 UTF-8、未压缩 JSON：

| 字段 | 要求 |
| --- | --- |
| `metadata.project_id` | 1–64 位小写字母、数字、`_`、`-`，首位是字母或数字；必须已配置 |
| `metadata.task_id` | 1–128 位大小写字母、数字、`.`、`_`、`:`、`-`，首位是字母或数字 |
| `instruction` | 必填非空字符串，最多 32768 个字符；原样作为用户提示词，仅替换声明过的 `@file_id` |
| `files` | 必填数组，元素为 `{ "file_id": "..." }`；最多 20 项，不可重复，合计不超过 200 MiB |

不接受额外字段。JSON 请求体最大 1 MiB。首次受理返回 `202`：

```json
{
  "metadata": {"project_id": "news", "task_id": "task-001"},
  "status": "queued",
  "duplicate": false
}
```

`Location` 响应头给出查询路径。同项目、同任务 ID、相同提示词及相同顺序文件列表再次提交，返回 `200` 和 `duplicate: true`，不重复执行；内容改变则返回 `409 / TASK_CONFLICT`。JSON 属性排列顺序不影响幂等判断。

### 查询：GET /projects/{project_id}/tasks/{task_id}

成功返回 `200`。执行完成时的示例：

```json
{
  "metadata": {"project_id": "news", "task_id": "task-001"},
  "status": "completed",
  "execution": {"attempts": 1, "session_id": "dsh-session-id", "next_retry_at": null, "last_error": null},
  "delivery": {"status": "delivered", "attempts": 1, "next_retry_at": null, "last_error": null},
  "created_at": "2026-11-02T08:00:00.000Z",
  "completed_at": "2026-11-02T08:00:20.000Z",
  "delivered_at": "2026-11-02T08:00:21.000Z",
  "result": "处理完成。",
  "files": []
}
```

`attempts` 包括首次尝试。`session_id` 是最近一次尝试的会话 ID，尚未执行时为空。时间均为 UTC ISO 8601；尚未发生的时间为 `null`。仅 `completed` 包含 `result` 和 `files`，回调最终失败后它们仍可查询。

| 执行状态 | 含义 |
| --- | --- |
| `queued` | 已受理，等待执行空位 |
| `running` | 当前会话正在执行 |
| `retrying` | 本次失败，等待下一次新会话尝试 |
| `completed` | 结果已持久化；不代表回调已成功 |
| `failed` | 执行尝试耗尽 |

| 回调状态 | 含义 |
| --- | --- |
| `not_ready` | 尚无完成结果 |
| `pending` | 等待或正在进行首次回调 |
| `retrying` | 等待或正在重试回调 |
| `delivered` | 接收方返回 2xx |
| `failed` | 11 次发送均未成功 |

执行错误使用 `EXECUTION_ERROR`、`EXECUTION_TIMEOUT` 或 `EXECUTION_INTERRUPTED`；具体执行原因见 dsh 插件日志。回调错误是 `HTTP <状态码>`、`CALLBACK_TIMEOUT`、`CALLBACK_INTERRUPTED` 或 `CALLBACK_TRANSPORT_OR_CREDENTIAL_ERROR`。

### 下载：GET /projects/{project_id}/files/{file_id}

成功返回 `200` 和文件二进制，支持已上传的输入文件及已发布的结果文件。无需任务 ID；文件必须属于该项目。

响应头包括 `Content-Type: application/octet-stream`、`Content-Length`、`Content-Disposition` 和 `X-DSH-File-SHA256`。下载前检查文件大小及 SHA-256，内容被外部改写时返回 `422 / FILE_UNAVAILABLE`。只支持 GET，不提供 HEAD 或 Range 分段下载协议。

### 结果回调

插件向项目配置的地址发 `POST`，请求体见第 5 节。默认请求头是 `Content-Type: application/json`、`X-DSH-Protocol-Version: 2`，再添加项目配置的自定义头。

自定义头必须为字符串键值对，最多 32 项，JSON 总大小最多 8 KiB。名称大小写不敏感，不可重复。不能覆盖上述两个固定头、Host、Content-Length、连接控制或代理认证等保留字段；非法字符和换行会被配置校验拒绝。

仅 2xx 表示成功，不跟随 3xx 重定向。失败后固定重试 10 次，每次间隔 60 秒。重试使用相同请求体和原任务配置，不再次运行 AI。接收端应按 `(project_id, task_id)` 处理重复回调，在完成接收或可靠保存后再返回成功。

### 错误响应

```json
{"error": {"code": "TASK_NOT_FOUND", "message": "Task not found"}}
```

| HTTP 状态 | 常见 code | 处理方式 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_UPLOAD`、`UPLOAD_ABORTED` | 修正字段、ID 或上传格式，检查请求是否中断 |
| 401 | `UNAUTHORIZED` | 检查项目请求令牌及 Authorization 请求头 |
| 404 | `PROJECT_NOT_FOUND`、`TASK_NOT_FOUND`、`NOT_FOUND` | 检查项目配置、资源 ID 和接口前缀 |
| 404 | `FILE_NOT_FOUND` | 文件或其元数据不存在，或不属于当前项目；检查项目及文件 ID，必要时重新上传 |
| 404 | `SESSION_NOT_FOUND` | 会话已被删除，停止查询该任务 |
| 405 | `METHOD_NOT_ALLOWED` | 使用对应接口规定的方法，参考 Allow 头 |
| 408 | `UPLOAD_TIMEOUT` | 上传超时，可重新上传 |
| 409 | `TASK_CONFLICT` | 同任务 ID 的内容不同；使用原请求或新任务 ID |
| 413 | `PAYLOAD_TOO_LARGE`、`FILE_TOO_LARGE`、`TASK_FILES_TOO_LARGE` | 减少请求或文件大小 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 使用正确 Content-Type 和未压缩正文 |
| 422 | `FILE_UNAVAILABLE` | 文件元数据无效、内容改变或路径不受支持；重新上传输入文件 |
| 429 | `UPLOAD_BUSY` | 上传并发已满，稍后重试 |
| 503 | `SERVICE_UNAVAILABLE`、`FILE_STORAGE_ERROR` | 检查插件是否启用、配置应用和磁盘错误 |

程序根据 HTTP 状态及 `error.code` 分支，`message` 用于展示，不作为稳定协议解析。

## 8. 限制与任务执行

### 限制与默认值

| 项目 | 当前值 |
| --- | --- |
| 任务 JSON / 最终文本 JSON 编码 | 各最多 1 MiB |
| 提示词 | 最多 32768 个字符 |
| 单文件 / 每任务文件数量 / 总大小 | 50 MiB / 20 个 / 200 MiB |
| 上传并发 | 每项目 2 个，全局 8 个，与执行并发独立 |
| 上传和下载传输超时 | 120 秒 |
| 单次执行超时 | 默认 1800 秒，可配置 |
| 执行重试 | 默认 3 次，间隔 60 秒，均可配置；加首次最多 4 次 |
| 单次回调超时 | 默认 10 秒，可配置 |
| 回调重试 | 固定 10 次，间隔 60 秒；加首次最多 11 次 |

### 排队与重试

- 最大并发留空或为 0 时不限制；正整数限制当前项目的执行会话，多余任务按可执行时间排队。回调使用独立队列。
- 执行重试次数不包含首次执行，设为 0 则只执行一次。会话初始化或执行失败都会消耗重试额度，每次重试创建新会话。
- 执行失败且重试耗尽后，通过查询接口查看失败状态。成功完成的任务才发送结果回调；回调失败只重发结果。
- 重启后继续处理已排队任务和剩余回调；被中断的执行按剩余次数重试，不重置已消耗次数。业务操作的幂等性由业务项目处理。
- 会话删除后停止处理其任务，查询返回 `404 / SESSION_NOT_FOUND`。
