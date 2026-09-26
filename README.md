# B站评论 IP 属地

在**哔哩哔哩网页版**评论区补上 IP 属地，显示在每条评论的等级徽章右边，效果与手机 App 一致。

B 站手机 App 的评论区一直显示 IP 属地，**但网页版至今不显示**。其实评论接口一直带着这个字段，
只是网页版前端没有把它渲染出来 —— 这个扩展就是把它补上。

![效果预览](docs/preview.png)

> 上图里的属地是**为验证渲染效果而注入的测试数据**（测试用的是全新临时浏览器配置，未登录 B 站，
> 真实接口不会返回属地）。实际使用中显示的是该评论发布时的真实 IP 属地。

## 安装

1. 下载本仓库：

   ```bash
   git clone https://github.com/chaoy1/bilibili-web-ip-location.git
   ```

   或者点仓库页面右上角的 **Code → Download ZIP** 再解压。

2. 浏览器地址栏打开 `chrome://extensions`（华为浏览器若被拦截，试 `huawei://extensions`）。
3. 打开右上角的「**开发者模式**」。
4. 点「**加载已解压的扩展程序**」，选中仓库里的 **`bilibili-ip-location`** 子文件夹
   （注意：仓库名是 `bilibili-web-ip-location`，要选的是它**里面**的 `bilibili-ip-location`）。

装好后**先确认已登录 B 站**，然后打开任意视频页滚到评论区即可。

完整步骤与排错见 [docs/安装说明.md](docs/安装说明.md)。

## 兼容性

| 项 | 说明 |
|---|---|
| 扩展规范 | Manifest V3 |
| 实测环境 | 华为浏览器 PC 版 12.1.4.300（Chromium 99.0.4844.84） |
| 其它浏览器 | 理论上任意 Chromium 内核浏览器可用，但只对上面这一款做了真机验证（包括 `chrome://extensions` 的加载入口） |
| 权限 | 只有 `bilibili.com` 的内容脚本，**不申请任何网络权限**，无后台进程 |

## 它是怎么工作的

```
B站网页 JS  ──fetch/XHR──►  api.bilibili.com/x/v2/reply*
                                  │
                    ┌─────────────┴─────────────┐
                    │  hook.js（页面上下文）      │  读 reply_control.location + mid
                    └─────────────┬─────────────┘
                                  │ CustomEvent（跨 JS 世界传字符串）
                    ┌─────────────┴─────────────┐
                    │  content.js（隔离环境）     │  mid → 属地
                    └─────────────┬─────────────┘
                                  │ 递归穿透 Shadow DOM
                                  ▼
                    插到 <bili-comment-user-info> 的 #user-level 右边
```

下面四个设计要点，每一个都是被实测逼出来的。

### 1. 必须抓页面自己的请求，不能由扩展另发一次

属地在 B 站接口里叫 `reply_control.location`，形如 `IP属地：上海`。
**这个字段只在携带登录 Cookie 的请求里才有值**：

| 请求方式 | `reply_control.location` |
|---|---|
| 匿名请求（无 Cookie） | `""`（老接口）/ 字段直接缺失（新接口） |
| 携带登录 Cookie | `"IP属地：上海"` |

另外新接口 `x/v2/reply/wbi/main` 需要 `w_rid` wbi 签名，扩展自己算签名既复杂又容易触发风控。
所以钩子挂在页面自己的 `fetch` / `XMLHttpRequest` 上，直接复用网页已经算好的签名和 Cookie。

### 2. 不能靠改接口响应让 B 站自己渲染

最初的设想是：把 `location` 字段塞进响应 JSON，让 B 站前端自己显示。
**实测无效** —— 注入成功改写了 8 条评论的 `reply_control.location`，页面上渲染出 0 处。
B 站新版评论组件根本不读这个字段，所以只能自己插 DOM。

### 3. 评论区是 Web Component + 嵌套 Shadow DOM

新版评论区不是普通 HTML，而是 Lit 组件树，每一层都是独立的 Shadow DOM：

```
<bili-comments>                          ← 开放 shadow root
  #feed
    <bili-comment-thread-renderer>       ← 又一层 shadow root（主评论）
      <bili-comment-renderer>
        #body > #main > #header
          <bili-comment-user-info>       ← 又一层 shadow root
            #info
              #user-name[data-user-profile-id="1540824464"]
              #user-level
              #user-medal
      <bili-comment-replies-renderer>    ← 子回复，再套一层
        <bili-comment-reply-renderer>
          <bili-comment-user-info> ...
```

这意味着：

- `document.querySelector('.reply-item')` 之类的选择器**全部失效**；
- 普通 `<style>` / content.css **进不去** Shadow DOM，所以徽章样式一律用行内样式；
- Shadow DOM 内部的变化**不会**冒泡到外层 `MutationObserver`，必须给每棵发现到的 shadow root 单独挂 observer；
- DOM 上**拿不到评论的 `rpid`**，但用户名节点带着 **`data-user-profile-id`（即用户 mid）**，
  所以用 `mid → 属地` 建索引。

### 4. 渲染与注入细节

- 钩子用 `<script src="chrome-extension://...">` 注入页面上下文（Chromium 99 还没有 `world: "MAIN"`）。
  B 站的 CSP 未拦截该注入，已实测通过。
- 内容脚本跑在 `document_start`，先注册监听再注入钩子，不会漏掉首批请求。
- 徽章是**纯文字**，没有任何底片 / 边框 / 圆角，只做一层很淡的灰色，不抢视线。
- 插入位置是**等级徽章右边**，即 `用户名 → 等级 → IP属地 → 粉丝勋章`。
  锚定 `#user-level` 插入；该元素不存在时自动退回用户名右边。
  Lit 重渲染后位置可能被挪走，每次扫描都会检查并纠正回来。
- **左右间距要配平，必须先扣掉等级图标的透明留白。**
  B 站等级图标是 `viewBox="0 0 30 30"` 的 SVG，但红色胶囊只画在 `x ∈ [1, 20.4]` ——
  元素右边界往右还有约 **9.6px 是透明的**。徽章紧跟其后时这段空白会被算进视觉左间距，
  左边就明显比右边宽。所以 `margin-left` 取的是
  `目标间距(3.6px) − 透明留白(9.6px) = -6px`；负值正好落在那段透明区里，不会真的压住图标。
  实测三个徽章的可见间距均为 3.6px，与右侧 B 站自带空格间距完全一致。
- 文字颜色每 3 秒重新探测一次页面底色亮度，自动适配 B 站的浅色 / 深色主题。
- 旧版评论区（Vue 组件，`bili-comment-user-info` 不存在时）保留了兜底渲染路径。

## 目录结构

```
bilibili-web-ip-location/           ← 仓库根目录
├── README.md
├── LICENSE
├── .gitignore
├── docs/
│   ├── preview.png            效果预览图
│   └── 安装说明.md            完整安装步骤与排错
└── bilibili-ip-location/      ← 「加载已解压的扩展程序」选中这个子目录
    ├── manifest.json          Manifest V3
    ├── src/
    │   ├── hook.js            注入页面上下文，拦截评论接口，提取 mid + location
    │   └── content.js         接收数据 + 穿透 Shadow DOM 渲染徽章
    └── icons/                 16 / 48 / 128 图标
```

## 已验证项

在华为浏览器 12.1.4.300（Chromium 99.0.4844.84）真机上，用独立临时配置文件 + CDP 实测：

| 验证项 | 结果 |
|---|---|
| `chrome://extensions` 可访问 | ✅ 标题「扩展程序」 |
| 「开发者模式」开关存在 | ✅ `#devMode` |
| 「加载已解压的扩展程序」按钮存在 | ✅ 文案 `加载已解压的扩展程序` |
| 扩展可加载、内容脚本可运行 | ✅ |
| 钩子成功注入页面 JS 上下文 | ✅ `window.__BILI_IP_LOCATION_HOOK__ === true` |
| 评论接口响应被成功抓取 | ✅ |
| 主评论徽章渲染 | ✅ |
| **嵌套子回复徽章渲染** | ✅ 穿透 `thread → replies-renderer → reply-renderer → user-info` 四层 shadow root |
| 徽章插入位置正确 | ✅ 5/5 条 `previousElementSibling === #user-level` |
| 徽章为纯文字 | ✅ 计算样式 `background: rgba(0,0,0,0)`、`border: 0px`、`border-radius: 0px` |
| **左右间距相等** | ✅ 3/3 条 `visibleGap === 3.6px`，与右侧空格间距一致（`margin-left: -6px`） |

> 真机测试用的浏览器配置**未登录 B 站**，真实接口不返回属地，因此测试时通过 CDP 在网络层注入了测试值。
> 注入点与真实数据的字段位置完全一致，所以链路验证是有效的。

## 已知限制

- **必须登录 B 站**。未登录时 B 站接口不返回属地，插件无从显示。
- B 站 **2022 年 7 月上线 IP 属地功能之前**发布的老评论没有该数据。
- 转发动态、部分专栏/活动页等场景 B 站接口本身不返回属地。
- 同一用户在不同评论里属地不同时（例如出差），按 mid 建索引会复用最后一次抓到的值。
  实际使用中影响极小；要精确到单条评论，需要 B 站前端把 `rpid` 暴露到 DOM 上。
- 只针对华为浏览器 12.1.4.300（Chromium 99）做过真机验证。

## 调试

在 B 站页面按 `F12` 打开控制台：

```js
// 钩子是否装上（在页面上下文执行）
window.__BILI_IP_LOCATION_HOOK__
```

徽章元素带 `class="bili-ip-location-badge"`，可在 Elements 面板里搜到
（注意要先展开 `<bili-comments>` 及其子组件的 shadow root）。

## 隐私

扩展不收集、不上传任何数据，不向任何第三方服务器发请求，也没有后台进程。
它只在本机读取 B 站网页自己已经收到的接口响应，然后把属地画到页面上。

## 许可证

[MIT](LICENSE)
