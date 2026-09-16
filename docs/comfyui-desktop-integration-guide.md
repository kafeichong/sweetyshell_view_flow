# ComfyUI 桌面端集成指南

## 📦 文件结构

```
comfyui-video-flow-client/
├── __init__.py                          # Python 入口（已配置 WEB_DIRECTORY）
├── web/
│   ├── video_flow_history.js            # ✅ 扩展入口（ComfyUI自动加载）
│   ├── video_flow_history.css           # ✅ 样式文件
│   ├── js/                              # 组件目录
│   │   ├── ConsumptionPanel.js
│   │   ├── TaskListPanel.js
│   │   ├── TaskDetailModal.js
│   │   └── VideoFlowHistoryPanel.js
│   ├── css/                             # 备份样式目录
│   │   └── video_flow_history.css
│   └── test/
│       └── history_panel_test.html      # 独立测试页面
```

## 🚀 在 ComfyUI 中使用

### 前提条件

1. **后端服务已启动**：
   ```bash
   cd packages/backend
   npm start
   ```
   后端应运行在 `http://localhost:3000`

2. **ComfyUI 已安装本扩展**：
   - 扩展路径：`ComfyUI/custom_nodes/comfyui-video-flow-client/`
   - 或通过软链接：
     ```bash
     ln -s /path/to/packages/comfyui-video-flow-client /path/to/ComfyUI/custom_nodes/
     ```

### 配置步骤

#### 方法1：浏览器控制台配置（推荐）

1. 打开 ComfyUI 网页界面
2. 按 `F12` 打开开发者工具
3. 在控制台（Console）输入：
   ```javascript
   localStorage.setItem('videoflow_api_token', 'vf_88e571c7acae8200ae958d234758117b85b9e8632b5579e5b97391ffe49e0676');
   ```
4. 刷新页面（`F5` 或 `Ctrl+R`）

#### 方法2：通过测试页面配置

1. 打开测试页面：
   ```bash
   open packages/comfyui-video-flow-client/web/test/history_panel_test.html
   ```
2. 输入 Token 并保存
3. Token 会保存到 localStorage，ComfyUI 会自动读取

### 验证集成

1. **重启 ComfyUI**（如果已运行）

2. **查看面板**：
   - 打开 ComfyUI 界面
   - 右侧应出现"💳 消费与历史"面板
   - 面板会自动加载数据

3. **检查控制台**：
   打开浏览器控制台（F12），应该看到：
   ```
   [VideoFlow] Loading history panel...
   [VideoFlow] History panel loaded successfully ✅
   ```

4. **测试功能**：
   - 查看消费概览（今日/本月）
   - 查看任务列表
   - 点击任务查看详情
   - 折叠/展开面板

## 🐛 故障排查

### 问题1：面板没有出现

**检查步骤**：

1. 确认扩展已加载：
   ```javascript
   // 在浏览器控制台运行
   console.log(window.videoFlowRefreshHistory);
   // 应输出: ƒ () { ... }
   ```

2. 检查 Token 配置：
   ```javascript
   console.log(localStorage.getItem('videoflow_api_token'));
   // 应输出: vf_xxxxx...
   ```

3. 查看控制台错误：
   - 按 `F12` 打开开发者工具
   - 查看 Console 标签是否有红色错误

4. 检查后端连接：
   ```javascript
   fetch('http://localhost:3000/api/health')
     .then(r => r.text())
     .then(console.log);
   ```

### 问题2：数据加载失败

**可能原因**：

1. **后端未启动**
   - 检查：`curl http://localhost:3000/api/v1/consumption/overview`
   - 解决：启动后端服务

2. **Token 无效**
   - 检查数据库中的 Token：
     ```sql
     SELECT actor_id, token_hash FROM actor_credentials;
     ```
   - 使用正确的 Token

3. **CORS 问题**
   - 检查后端 `.env` 文件中的 `CORS_ORIGIN` 配置
   - 应包含 ComfyUI 的访问地址

### 问题3：样式显示异常

**解决方法**：

1. 清除浏览器缓存：
   - Chrome: `Ctrl+Shift+Delete`
   - 选择"缓存的图像和文件"
   - 清除并刷新

2. 强制刷新：
   - Windows: `Ctrl+F5`
   - Mac: `Cmd+Shift+R`

3. 手动加载样式：
   ```javascript
   const link = document.createElement('link');
   link.rel = 'stylesheet';
   link.href = './extensions/comfyui-video-flow-client/video_flow_history.css';
   document.head.appendChild(link);
   ```

## 🔧 高级配置

### 修改 API 地址

如果后端不在 `localhost:3000`，修改组件中的 API 地址：

编辑 `ConsumptionPanel.js`、`TaskListPanel.js`、`TaskDetailModal.js`：

```javascript
async fetchData() {
  const token = this.getToken();
  const baseUrl = 'http://your-backend-url:port'; // 修改这里
  
  const response = await fetch(`${baseUrl}/api/v1/consumption/overview`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.json();
}
```

### 自定义面板位置

编辑 `video_flow_history.js`：

```javascript
// 修改容器创建逻辑
const container = document.createElement('div');
container.className = 'vf-sidebar-container';
container.style.cssText = `
  position: fixed;
  right: 20px;      /* 修改位置 */
  top: 80px;        /* 修改位置 */
  z-index: 1000;
`;
document.body.appendChild(container);
```

### 修改刷新间隔

编辑 `video_flow_history.js`：

```javascript
setTimeout(() => {
  if (historyPanel) {
    historyPanel.refresh();
  }
}, 2000); // 改为2秒
```

## 📱 功能说明

### 消费概览
- 显示今日和本月的消费情况
- 配额和剩余额度
- 消费超过80%显示橙色警告
- 消费超过90%显示红色危险

### 任务列表
- 显示最近10条任务
- 状态图标和颜色区分
- 点击任务查看完整详情
- 时间显示（相对时间）

### 任务详情
- 任务基本信息
- 工作流和参数
- 完整提示词
- 执行记录
- 输出资源列表

## 🎯 使用技巧

1. **快速刷新**：
   ```javascript
   window.videoFlowRefreshHistory();
   ```

2. **查看 Token**：
   ```javascript
   console.log(localStorage.getItem('videoflow_api_token'));
   ```

3. **清除 Token**：
   ```javascript
   localStorage.removeItem('videoflow_api_token');
   ```

4. **折叠面板**：点击面板标题栏的折叠按钮

## 📞 获取支持

如果遇到问题：

1. 查看浏览器控制台错误信息
2. 检查后端日志：`tail -f /tmp/backend.log`
3. 查看 API 测试结果：`docs/api-testing-results.md`
4. 参考实施文档：`docs/comfyui-history-panel-implementation.md`

## ✅ 测试清单

- [ ] 后端服务已启动并可访问
- [ ] Token 已配置到 localStorage
- [ ] ComfyUI 已加载扩展
- [ ] 面板出现在页面右侧
- [ ] 消费概览正常显示
- [ ] 任务列表可以加载
- [ ] 点击任务可以打开详情
- [ ] 提交新任务后列表自动刷新

全部完成？恭喜！你已成功集成消费历史面板！🎉
