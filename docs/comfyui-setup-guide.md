# 在 ComfyUI 中使用消费历史面板

## 🎯 快速配置（3步）

### 第1步：打开 ComfyUI
访问：**http://localhost:8188**

### 第2步：配置 Token
1. 按 `F12` 打开开发者工具
2. 切换到 `Console`（控制台）标签
3. 粘贴以下代码并按回车：

```javascript
localStorage.setItem('videoflow_api_token', 'vf_88e571c7acae8200ae958d234758117b85b9e8632b5579e5b97391ffe49e0676');
localStorage.setItem('videoflow_api_base_url', 'http://localhost:3000');
console.log('✅ Token 配置完成！');
```

### 第3步：刷新页面
按 `F5` 或 `Ctrl+R` 刷新 ComfyUI 页面

---

## ✨ 预期效果

刷新后，你会在 ComfyUI 界面右侧看到：

```
┌─────────────────────────────┐
│ 💳 消费与历史 [▼]          │
├─────────────────────────────┤
│ 📊 今日消费: ¥0 / ¥100    │
│    剩余: ¥100               │
│                              │
│ 📅 本月消费: ¥0 / ¥1000   │
│    剩余: ¥1000              │
├─────────────────────────────┤
│ 📝 最近任务                 │
│ (显示最近的任务列表)        │
└─────────────────────────────┘
```

---

## 🧪 验证面板是否加载

在控制台中应该看到：
```
[VideoFlow] Loading history panel...
[VideoFlow] History panel loaded successfully ✅
```

---

## 🐛 如果没有看到面板

### 检查1：确认扩展已加载
在控制台运行：
```javascript
window.videoFlowRefreshHistory
```
应该显示：`ƒ () { ... }`

### 检查2：手动刷新数据
```javascript
window.videoFlowRefreshHistory();
```

### 检查3：查看错误信息
按 `F12`，查看 Console 标签中的红色错误

---

## 📱 面板功能

- **消费概览**：实时显示今日和本月的消费、配额
- **任务列表**：最近10条任务，点击查看详情
- **折叠面板**：点击标题栏的折叠按钮
- **自动刷新**：提交任务后自动更新

---

## 🔧 更换 Token

如果要用其他账户，在控制台运行：

```javascript
// test-consumer (测试账户)
localStorage.setItem('videoflow_api_token', 'vf_88e571c7acae8200ae958d234758117b85b9e8632b5579e5b97391ffe49e0676');

// 或 paid-actor (付费账户)
localStorage.setItem('videoflow_api_token', 'vf_37e12cf554e68811a2b7abfa707837cc3468673d0b69b08b695fec04912b4257');

// 或 preview-actor (预览账户)
localStorage.setItem('videoflow_api_token', 'vf_6c16a67dbd35f2bbcc79f9260f91ef710afdabe90a0d293bfd80fbad9d835c37');

// 然后刷新页面
location.reload();
```

---

## 📞 需要帮助？

如果遇到问题，告诉我：
1. 控制台有什么错误信息？
2. 面板有显示吗？在哪个位置？
3. 数据能加载吗？

祝使用愉快！🎉
