/**
 * 任务历史列表组件
 * 显示最近的任务列表
 */

export class TaskListPanel {
  constructor(container) {
    this.container = container;
    this.tasks = [];
    this.element = this.createElement();
  }

  createElement() {
    const panel = document.createElement('div');
    panel.className = 'vf-task-list-panel';
    panel.innerHTML = `
      <div class="vf-task-list-header">
        <h3>📝 最近任务</h3>
        <button class="vf-refresh-btn" title="刷新">🔄</button>
      </div>
      <div class="vf-task-list-content">
        <div class="vf-task-items"></div>
      </div>
      <div class="vf-task-list-loading" style="display: none;">
        <div class="vf-spinner"></div>
        <span>加载中...</span>
      </div>
      <div class="vf-task-list-error" style="display: none;">
        <span class="vf-error-msg"></span>
        <button class="vf-retry-btn">重试</button>
      </div>
      <div class="vf-task-list-empty" style="display: none;">
        <span>暂无任务记录</span>
      </div>
    `;

    const refreshBtn = panel.querySelector('.vf-refresh-btn');
    refreshBtn.addEventListener('click', () => this.refresh());

    const retryBtn = panel.querySelector('.vf-retry-btn');
    retryBtn.addEventListener('click', () => this.refresh());

    return panel;
  }

  async fetchData() {
    // 使用 ComfyUI 代理 API
    const response = await fetch('/video_flow/api/tasks?limit=10', {
      method: 'GET',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `请求失败: ${response.status}`);
    }

    const data = await response.json();
    return data.tasks || [];
  }

  getToken() {
    // 已废弃：现在使用代理 API
    return null;
  }

  async refresh() {
    this.showLoading();
    try {
      this.tasks = await this.fetchData();
      this.render();
      if (this.tasks.length === 0) {
        this.showEmpty();
      } else {
        this.showContent();
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
      this.showError(error.message);
    }
  }

  render() {
    const container = this.element.querySelector('.vf-task-items');
    container.innerHTML = '';

    this.tasks.forEach(task => {
      const taskItem = this.createTaskItem(task);
      container.appendChild(taskItem);
    });
  }

  createTaskItem(task) {
    const item = document.createElement('div');
    item.className = 'vf-task-item';
    item.dataset.taskId = task.id;

    const statusEmoji = this.getStatusEmoji(task.status);
    const statusText = this.getStatusText(task.status);
    const timeAgo = this.formatTimeAgo(task.createdAt);
    const workflowName = task.workflowName || '未知工作流';
    const cost = task.cost.settled || task.cost.reserved || '--';

    item.innerHTML = `
      <div class="vf-task-main">
        <div class="vf-task-title">
          <span class="vf-task-status ${task.status}">${statusEmoji} ${statusText}</span>
          <span class="vf-task-workflow">${workflowName}</span>
        </div>
        <div class="vf-task-meta">
          <span class="vf-task-time">🕐 ${timeAgo}</span>
          ${cost !== '--' ? `<span class="vf-task-cost">💰 ¥${cost}</span>` : ''}
        </div>
      </div>
      <div class="vf-task-preview">
        ${this.truncateText(task.promptPreview, 50)}
      </div>
    `;

    // 点击查看详情
    item.addEventListener('click', () => {
      this.onTaskClick(task.id);
    });

    return item;
  }

  getStatusEmoji(status) {
    const emojiMap = {
      'pending': '⏳',
      'running': '⚙️',
      'completed': '✅',
      'failed': '❌',
      'cancelled': '🚫',
    };
    return emojiMap[status] || '❓';
  }

  getStatusText(status) {
    const textMap = {
      'pending': '等待中',
      'running': '处理中',
      'completed': '已完成',
      'failed': '失败',
      'cancelled': '已取消',
    };
    return textMap[status] || status;
  }

  formatTimeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    return date.toLocaleDateString('zh-CN');
  }

  truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  onTaskClick(taskId) {
    // 触发自定义事件，由父组件处理
    const event = new CustomEvent('task-detail-requested', {
      detail: { taskId },
      bubbles: true,
    });
    this.element.dispatchEvent(event);
  }

  showLoading() {
    this.element.querySelector('.vf-task-list-content').style.display = 'none';
    this.element.querySelector('.vf-task-list-error').style.display = 'none';
    this.element.querySelector('.vf-task-list-empty').style.display = 'none';
    this.element.querySelector('.vf-task-list-loading').style.display = 'flex';
  }

  showContent() {
    this.element.querySelector('.vf-task-list-loading').style.display = 'none';
    this.element.querySelector('.vf-task-list-error').style.display = 'none';
    this.element.querySelector('.vf-task-list-empty').style.display = 'none';
    this.element.querySelector('.vf-task-list-content').style.display = 'block';
  }

  showError(message) {
    this.element.querySelector('.vf-task-list-content').style.display = 'none';
    this.element.querySelector('.vf-task-list-loading').style.display = 'none';
    this.element.querySelector('.vf-task-list-empty').style.display = 'none';
    this.element.querySelector('.vf-task-list-error').style.display = 'flex';
    this.element.querySelector('.vf-error-msg').textContent = message;
  }

  showEmpty() {
    this.element.querySelector('.vf-task-list-content').style.display = 'none';
    this.element.querySelector('.vf-task-list-loading').style.display = 'none';
    this.element.querySelector('.vf-task-list-error').style.display = 'none';
    this.element.querySelector('.vf-task-list-empty').style.display = 'flex';
  }

  mount() {
    this.container.appendChild(this.element);
    this.refresh();
  }

  unmount() {
    this.element.remove();
  }
}
