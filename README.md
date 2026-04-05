# SkillBottle Web (WorkHub)

一个“前端项目终端”：把多个纯前端子项目放进 `app/` 目录后，首页会自动生成左侧导航，并用 `iframe` 在右侧打开对应的 `index.html`。支持管理模式（重命名、锁定、导出为纯静态站点）。

## 目录结构

- `app.py`：FastAPI 后端（静态文件托管 + API）
- `frontend/`：框架首页（`index.html` + `app.js` + `styles.css`）
- `app/`：子项目目录（每个子目录必须包含 `index.html`）
- `result/`：导出产物目录（`export-YYYYMMDD-HHMMSS/`）
- `.skillbottle_admin.json`：管理员密码（PBKDF2 哈希）配置文件（可选）

## 快速开始（后端模式）

1) 安装依赖

```bash
pip install -r requirements.txt
```

2) 启动服务

```bash
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

3) 访问首页

- `http://127.0.0.1:8000/`

> 如果你的环境里没有 `pip/uvicorn` 命令，请先确保已安装 Python 3，并使用 `python -m pip ...` / `python -m uvicorn ...`。

## 添加一个子项目

在 `app/` 下创建子目录，并放置 `index.html`：

```text
app/
  demo/
    index.html
```

后端模式下访问路径为：

- `http://127.0.0.1:8000/apps/demo/index.html`

首页左侧导航会通过 API 自动发现这些项目并展示。

## 前端工作方式（首页加载逻辑）

`frontend/app.js` 在启动时会按以下优先级加载“目录清单”：

1) 导出版本内嵌的 `#sb-manifest`（`index.html` 里嵌入的 JSON）
2) 同目录的 `./manifest.json`（导出目录下存在）
3) 后端 API：`/api/nav`（在线/开发模式）

因此：

- **后端模式**：需要 `uvicorn app:app`，目录来自 `/api/nav`
- **纯静态模式**：打开/托管导出目录即可（无需 Python）

## 管理模式

管理模式入口在左侧导航每一项的“更多 (...)”菜单里：

- **管理模式**：输入管理员密码进入（进入后会出现“高级模块”）
- **应用编辑**：给条目改显示名称（存储在浏览器 `localStorage`）
- **管理锁定**：锁定条目（普通模式下不可打开）
- **导出为静态页面**：在“高级模块”里点击“导出”

## 管理员密码配置

管理员密码有两种来源（优先级：环境变量 > 文件）：

- 环境变量：`SKILLBOTTLE_ADMIN_PASSWORD`（或 `ADMIN_PASSWORD`）
- 文件：项目根目录下的 `.skillbottle_admin.json`（PBKDF2-SHA256）

未配置时，首次进入管理模式会提示注册密码并写入 `.skillbottle_admin.json`。

## API（后端）

后端前缀：`/api`

- `GET /api/health`：健康检查
- `GET /api/meta`：站点元信息（当前仅返回标题）
- `GET /api/nav`：扫描 `app/` 目录生成导航
- `GET|POST /api/export`：导出为纯静态站点到 `result/export-*/`
- `GET /api/admin/status`：管理员配置状态
- `POST /api/admin/register`：注册管理员密码（仅未配置时可用）
- `POST /api/admin/change`：修改管理员密码
- `POST /api/admin/verify`：验证管理员密码

## 日志与环境变量

- `SKILLBOTTLE_LOG_LEVEL`：日志级别（默认 `INFO`）

请求日志会记录 `/`、`/index.html` 和 `/api/*` 的访问与耗时。

