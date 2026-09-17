/**
 * 消费与任务历史主面板
 * 集成消费概览、任务列表和详情弹窗
 */

import { ConsumptionPanel } from './ConsumptionPanel.js';
import { TaskListPanel } from './TaskListPanel.js';
import { TaskDetailModal } from './TaskDetailModal.js';

export class VideoFlowHistoryPanel {
  constructor() {
    this.isOpen = false;
    this.element = this.createElement();
    this.tabElement = this.createTabElement();
    this.consumptionPanel = null;
    this.taskListPanel = null;
    this.taskDetailModal = null;
  }

  createTabElement() {
    const tab = document.createElement('div');
    tab.className = 'vf-sidebar-tab';
    tab.innerHTML = `
      <div class="vf-tab-icon">💳</div>
      <div class="vf-tab-text">消费历史</div>
    `;

    tab.addEventListener('click', () => this.toggle());
    return tab;
  }

  createElement() {
    const panel = document.createElement('div');
    panel.className = 'vf-history-panel vf-closed';
    panel.innerHTML = `
      <div class="vf-panel-header">
        <h2>💳 消费与历史</h2>
        <button class="vf-close-btn" title="关闭">✕</button>
      </div>
      <div class="vf-panel-body">
        <div class="vf-consumption-container"></div>
        <div class="vf-task-list-container"></div>
      </div>
    `;

    // 关闭按钮
    const closeBtn = panel.querySelector('.vf-close-btn');
    closeBtn.addEventListener('click', () => this.close());

    // 监听任务详情请求事件
    panel.addEventListener('task-detail-requested', (e) => {
      this.showTaskDetail(e.detail.taskId);
    });

    return panel;
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.element.classList.remove('vf-closed');
    this.element.classList.add('vf-open');
    this.tabElement.classList.add('vf-tab-active');

    // 首次打开时加载数据
    if (this.consumptionPanel && !this.consumptionPanel.data) {
      this.refresh();
    }
  }

  close() {
    this.isOpen = false;
    this.element.classList.remove('vf-open');
    this.element.classList.add('vf-closed');
    this.tabElement.classList.remove('vf-tab-active');
  }

  showTaskDetail(taskId) {
    if (this.taskDetailModal) {
      this.taskDetailModal.open(taskId);
    }
  }

  mount(container) {
    // 添加标签和面板到容器
    container.appendChild(this.tabElement);
    container.appendChild(this.element);

    // 初始化子组件
    const consumptionContainer = this.element.querySelector('.vf-consumption-container');
    const taskListContainer = this.element.querySelector('.vf-task-list-container');

    this.consumptionPanel = new ConsumptionPanel(consumptionContainer);
    this.consumptionPanel.mount();

    this.taskListPanel = new TaskListPanel(taskListContainer);
    this.taskListPanel.mount();

    this.taskDetailModal = new TaskDetailModal();
    this.taskDetailModal.mount();
  }

  unmount() {
    if (this.consumptionPanel) this.consumptionPanel.unmount();
    if (this.taskListPanel) this.taskListPanel.unmount();
    if (this.taskDetailModal) this.taskDetailModal.unmount();
    this.element.remove();
  }

  refresh() {
    if (this.consumptionPanel) this.consumptionPanel.refresh();
    if (this.taskListPanel) this.taskListPanel.refresh();
  }
}
