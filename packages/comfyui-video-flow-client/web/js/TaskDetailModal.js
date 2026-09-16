/**
 * 任务详情弹窗组件
 * 显示任务的完整信息
 */

export class TaskDetailModal {
  constructor() {
    this.taskId = null;
    this.taskData = null;
    this.element = this.createElement();
  }

  createElement() {
    const modal = document.createElement('div');
    modal.className = 'vf-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="vf-modal-overlay"></div>
      <div class="vf-modal-content">
        <div class="vf-modal-header">
          <h2>任务详情</h2>
          <button class="vf-modal-close" title="关闭">✕</button>
        </div>
        <div class="vf-modal-body">
          <div class="vf-detail-loading" style="display: flex;">
            <div class="vf-spinner"></div>
            <span>加载中...</span>
          </div>
          <div class="vf-detail-content" style="display: none;"></div>
          <div class="vf-detail-error" style="display: none;">
            <span class="vf-error-msg"></span>
            <button class="vf-retry-btn">重试</button>
          </div>
        </div>
      </div>
    `;

    // 关闭按钮
    const closeBtn = modal.querySelector('.vf-modal-close');
    closeBtn.addEventListener('click', () => this.close());

    // 点击遮罩关闭
    const overlay = modal.querySelector('.vf-modal-overlay');
    overlay.addEventListener('click', () => this.close());

    // 重试按钮
    const retryBtn = modal.querySelector('.vf-retry-btn');
    retryBtn.addEventListener('click', () => this.fetchTaskDetail());

    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        this.close();
      }
    });

    return modal;
  }

  async fetchTaskDetail() {
    // 使用 ComfyUI 代理 API
    const response = await fetch(`/video_flow/api/tasks/${this.taskId}/detail`, {
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
    // 已废弃：现在使用代理 API
    return null;
  }

  async open(taskId) {
    this.taskId = taskId;
    this.element.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    this.showLoading();
    try {
      this.taskData = await this.fetchTaskDetail();
      this.render();
      this.showContent();
    } catch (error) {
      console.error('Failed to fetch task detail:', error);
      this.showError(error.message);
    }
  }

  close() {
    this.element.style.display = 'none';
    document.body.style.overflow = '';
    this.taskId = null;
    this.taskData = null;
  }

  render() {
    if (!this.taskData) return;

    const { task, submissionDetails, attempts, assets, budget } = this.taskData;

    const content = this.element.querySelector('.vf-detail-content');
    content.innerHTML = `
      <div class="vf-detail-section">
        <h3>📋 基本信息</h3>
        <div class="vf-detail-grid">
          <div class="vf-detail-item">
            <span class="vf-label">任务ID:</span>
            <span class="vf-value vf-monospace">${task.id}</span>
          </div>
          <div class="vf-detail-item">
            <span class="vf-label">状态:</span>
            <span class="vf-value vf-status ${task.status}">${this.getStatusText(task.status)}</span>
          </div>
          <div class="vf-detail-item">
            <span class="vf-label">创建时间:</span>
            <span class="vf-value">${this.formatDateTime(task.createdAt)}</span>
          </div>
          <div class="vf-detail-item">
            <span class="vf-label">完成时间:</span>
            <span class="vf-value">${task.completedAt ? this.formatDateTime(task.completedAt) : '--'}</span>
          </div>
        </div>
        ${task.errorMsg ? `<div class="vf-error-box">❌ ${task.errorMsg}</div>` : ''}
      </div>

      <div class="vf-detail-section">
        <h3>🎬 工作流信息</h3>
        <div class="vf-detail-grid">
          <div class="vf-detail-item">
            <span class="vf-label">工作流:</span>
            <span class="vf-value">${submissionDetails.workflow.name || submissionDetails.workflow.key || '--'}</span>
          </div>
          <div class="vf-detail-item">
            <span class="vf-label">版本:</span>
            <span class="vf-value">${submissionDetails.workflow.version || '--'}</span>
          </div>
        </div>
      </div>

      <div class="vf-detail-section">
        <h3>✏️ 提示词</h3>
        <div class="vf-prompt-box">
          ${submissionDetails.prompt.text || '--'}
        </div>
        <div class="vf-prompt-meta">字数: ${submissionDetails.prompt.length || 0}</div>
      </div>

      ${Object.keys(submissionDetails.generation).length > 0 ? `
        <div class="vf-detail-section">
          <h3>⚙️ 生成参数</h3>
          <div class="vf-detail-grid">
            ${this.renderGenerationParams(submissionDetails.generation)}
          </div>
        </div>
      ` : ''}

      ${budget ? `
        <div class="vf-detail-section">
          <h3>💰 费用信息</h3>
          <div class="vf-detail-grid">
            <div class="vf-detail-item">
              <span class="vf-label">预留金额:</span>
              <span class="vf-value">¥${budget.reservedCny || '--'}</span>
            </div>
            <div class="vf-detail-item">
              <span class="vf-label">结算金额:</span>
              <span class="vf-value">¥${budget.settledCny || '--'}</span>
            </div>
            <div class="vf-detail-item">
              <span class="vf-label">状态:</span>
              <span class="vf-value">${budget.state || '--'}</span>
            </div>
          </div>
        </div>
      ` : ''}

      ${attempts.length > 0 ? `
        <div class="vf-detail-section">
          <h3>🔄 执行记录 (${attempts.length})</h3>
          ${this.renderAttempts(attempts)}
        </div>
      ` : ''}

      ${assets.length > 0 ? `
        <div class="vf-detail-section">
          <h3>📦 输出资源 (${assets.length})</h3>
          ${this.renderAssets(assets)}
        </div>
      ` : ''}
    `;
  }

  renderGenerationParams(generation) {
    const params = [];
    if (generation.model) params.push({ label: '模型', value: generation.model });
    if (generation.duration) params.push({ label: '时长', value: `${generation.duration}秒` });
    if (generation.resolution) params.push({ label: '分辨率', value: generation.resolution });
    if (generation.ratio) params.push({ label: '宽高比', value: generation.ratio });
    if (generation.frameRate) params.push({ label: '帧率', value: `${generation.frameRate} fps` });

    return params.map(p => `
      <div class="vf-detail-item">
        <span class="vf-label">${p.label}:</span>
        <span class="vf-value">${p.value}</span>
      </div>
    `).join('');
  }

  renderAttempts(attempts) {
    return attempts.map((attempt, index) => `
      <div class="vf-attempt-item">
        <div class="vf-attempt-header">
          <span class="vf-attempt-no">#${attempt.attemptNo || index + 1}</span>
          <span class="vf-attempt-status ${attempt.status}">${this.getStatusText(attempt.status)}</span>
        </div>
        <div class="vf-attempt-details">
          <div>提供商: ${attempt.provider || '--'}</div>
          <div>开始: ${attempt.startedAt ? this.formatDateTime(attempt.startedAt) : '--'}</div>
          <div>结束: ${attempt.finishedAt ? this.formatDateTime(attempt.finishedAt) : '--'}</div>
          ${attempt.billedCostCny ? `<div>费用: ¥${attempt.billedCostCny}</div>` : ''}
          ${attempt.failureMessage ? `<div class="vf-failure-msg">❌ ${attempt.failureMessage}</div>` : ''}
        </div>
      </div>
    `).join('');
  }

  renderAssets(assets) {
    return assets.map(asset => `
      <div class="vf-asset-item">
        <div class="vf-asset-icon">${this.getAssetIcon(asset.mediaType)}</div>
        <div class="vf-asset-info">
          <div class="vf-asset-role">${asset.role || '输出'}</div>
          <div class="vf-asset-meta">
            ${asset.mimeType || ''} ${asset.sizeBytes ? `· ${this.formatBytes(asset.sizeBytes)}` : ''}
          </div>
        </div>
      </div>
    `).join('');
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

  getAssetIcon(mediaType) {
    if (mediaType?.includes('video')) return '🎬';
    if (mediaType?.includes('image')) return '🖼️';
    if (mediaType?.includes('audio')) return '🎵';
    return '📄';
  }

  formatDateTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  showLoading() {
    this.element.querySelector('.vf-detail-content').style.display = 'none';
    this.element.querySelector('.vf-detail-error').style.display = 'none';
    this.element.querySelector('.vf-detail-loading').style.display = 'flex';
  }

  showContent() {
    this.element.querySelector('.vf-detail-loading').style.display = 'none';
    this.element.querySelector('.vf-detail-error').style.display = 'none';
    this.element.querySelector('.vf-detail-content').style.display = 'block';
  }

  showError(message) {
    this.element.querySelector('.vf-detail-content').style.display = 'none';
    this.element.querySelector('.vf-detail-loading').style.display = 'none';
    this.element.querySelector('.vf-detail-error').style.display = 'flex';
    this.element.querySelector('.vf-error-msg').textContent = message;
  }

  mount() {
    document.body.appendChild(this.element);
  }

  unmount() {
    this.element.remove();
  }
}
