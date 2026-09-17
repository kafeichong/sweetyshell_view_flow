/**
 * 消费概览面板组件
 * 显示今日和本月的消费、配额、剩余额度
 */

export class ConsumptionPanel {
  constructor(container) {
    this.container = container;
    this.data = null;
    this.element = this.createElement();
  }

  createElement() {
    const panel = document.createElement('div');
    panel.className = 'vf-consumption-panel';
    panel.innerHTML = `
      <div class="vf-consumption-header">
        <h3>💰 消费概览</h3>
        <button class="vf-refresh-btn" title="刷新">🔄</button>
      </div>
      <div class="vf-consumption-content">
        <div class="vf-stat-card vf-daily">
          <div class="vf-stat-label">📊 今日消费</div>
          <div class="vf-stat-value">
            <span class="vf-spent">--</span> / <span class="vf-limit">--</span>
          </div>
          <div class="vf-stat-remaining">剩余: <span>--</span></div>
          <div class="vf-stat-tasks">任务数: <span>--</span></div>
        </div>
        <div class="vf-stat-card vf-monthly">
          <div class="vf-stat-label">📅 本月消费</div>
          <div class="vf-stat-value">
            <span class="vf-spent">--</span> / <span class="vf-limit">--</span>
          </div>
          <div class="vf-stat-remaining">剩余: <span>--</span></div>
          <div class="vf-stat-tasks">任务数: <span>--</span></div>
        </div>
      </div>
      <div class="vf-consumption-loading" style="display: none;">
        <div class="vf-spinner"></div>
        <span>加载中...</span>
      </div>
      <div class="vf-consumption-error" style="display: none;">
        <span class="vf-error-msg"></span>
        <button class="vf-retry-btn">重试</button>
      </div>
    `;

    const refreshBtn = panel.querySelector('.vf-refresh-btn');
    refreshBtn.addEventListener('click', () => this.refresh());

    const retryBtn = panel.querySelector('.vf-retry-btn');
    retryBtn.addEventListener('click', () => this.refresh());

    return panel;
  }

  async fetchData() {
    // 使用 ComfyUI 代理 API，Token 由后端管理
    const response = await fetch('/video_flow/api/consumption/overview', {
      method: 'GET',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `请求失败: ${response.status}`);
    }

    return response.json();
  }

  getToken() {
    // 已废弃：现在使用代理 API，不需要前端管理 Token
    return null;
  }

  async refresh() {
    this.showLoading();
    try {
      this.data = await this.fetchData();
      this.render();
      this.showContent();
    } catch (error) {
      console.error('Failed to fetch consumption data:', error);
      this.showError(error.message);
    }
  }

  render() {
    if (!this.data) return;

    const { daily, monthly } = this.data;

    // 渲染今日数据
    const dailyCard = this.element.querySelector('.vf-daily');
    dailyCard.querySelector('.vf-spent').textContent = `¥${daily.settled}`;
    dailyCard.querySelector('.vf-limit').textContent = `¥${daily.limit}`;
    dailyCard.querySelector('.vf-stat-remaining span').textContent = `¥${daily.remaining}`;
    dailyCard.querySelector('.vf-stat-tasks span').textContent = daily.taskCount;

    // 渲染本月数据
    const monthlyCard = this.element.querySelector('.vf-monthly');
    monthlyCard.querySelector('.vf-spent').textContent = `¥${monthly.settled}`;
    monthlyCard.querySelector('.vf-limit').textContent = `¥${monthly.limit}`;
    monthlyCard.querySelector('.vf-stat-remaining span').textContent = `¥${monthly.remaining}`;
    monthlyCard.querySelector('.vf-stat-tasks span').textContent = monthly.taskCount;

    // 添加警告样式（消费超过80%）
    this.updateWarningStyle(dailyCard, parseFloat(daily.settled), parseFloat(daily.limit));
    this.updateWarningStyle(monthlyCard, parseFloat(monthly.settled), parseFloat(monthly.limit));
  }

  updateWarningStyle(card, spent, limit) {
    const percentage = (spent / limit) * 100;
    card.classList.remove('vf-warning', 'vf-danger');

    if (percentage >= 90) {
      card.classList.add('vf-danger');
    } else if (percentage >= 80) {
      card.classList.add('vf-warning');
    }
  }

  showLoading() {
    this.element.querySelector('.vf-consumption-content').style.display = 'none';
    this.element.querySelector('.vf-consumption-error').style.display = 'none';
    this.element.querySelector('.vf-consumption-loading').style.display = 'flex';
  }

  showContent() {
    this.element.querySelector('.vf-consumption-loading').style.display = 'none';
    this.element.querySelector('.vf-consumption-error').style.display = 'none';
    this.element.querySelector('.vf-consumption-content').style.display = 'block';
  }

  showError(message) {
    this.element.querySelector('.vf-consumption-content').style.display = 'none';
    this.element.querySelector('.vf-consumption-loading').style.display = 'none';
    this.element.querySelector('.vf-consumption-error').style.display = 'flex';
    this.element.querySelector('.vf-error-msg').textContent = message;
  }

  mount() {
    this.container.appendChild(this.element);
    this.refresh();
  }

  unmount() {
    this.element.remove();
  }
}
