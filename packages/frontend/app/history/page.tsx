'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

interface TaskItem {
  id: string;
  workflowKey: string | null;
  workflowName: string | null;
  status: string;
  deliveryStatus: string | null;
  parameters: {
    duration?: number;
    resolution?: string;
    ratio?: string;
    model?: string;
  };
  promptPreview: string;
  cost: {
    reserved: string | null;
    settled: string | null;
    status: string | null;
  };
  createdAt: string;
  completedAt: string | null;
  hasOutput: boolean;
  outputReady: boolean;
}

interface TaskDetail {
  task: {
    id: string;
    status: string;
    deliveryStatus: string | null;
    createdAt: string;
    completedAt: string | null;
    errorMsg: string | null;
  };
  submissionDetails: {
    workflow: {
      key: string | null;
      name: string | null;
    };
    generation: {
      model?: string;
      duration?: number;
      resolution?: string;
      ratio?: string;
    };
    prompt: {
      text: string;
    };
    media: Array<{
      role: string;
      assetId: string;
      mimeType?: string;
    }>;
  };
  assets: Array<{
    assetId: string;
    role: string;
    objectKey: string;
    mimeType: string | null;
  }>;
}

export default function HistoryPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const mode = localStorage.getItem('auth_mode');
    if (mode === 'admin') {
      alert('管理员账号无法查看任务历史');
      router.push('/dashboard');
      return;
    }

    fetchTasks();
  }, [page]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const res = await api.get('/v1/tasks', {
        params: { page, limit: 20 },
      });
      setTasks(res.data.tasks);
      setTotalPages(res.data.pagination.totalPages);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
      alert('获取任务列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchTaskDetail = async (taskId: string) => {
    try {
      setDetailLoading(true);
      setSelectedTask(null);
      setMediaUrls({});

      const res = await api.get(`/v1/tasks/${taskId}/detail`);
      const detail: TaskDetail = res.data;
      setSelectedTask(detail);

      // 获取所有媒体资源的下载链接
      const urls: Record<string, string> = {};

      // 获取输入媒体
      for (const media of detail.submissionDetails.media) {
        try {
          const mediaRes = await api.get(`/v1/assets/${media.assetId}/download`);
          urls[media.assetId] = mediaRes.data.downloadUrl;
        } catch (err) {
          console.error(`Failed to get download URL for ${media.assetId}:`, err);
        }
      }

      // 获取输出媒体
      if (detail.task.deliveryStatus === 'ready') {
        try {
          const outputRes = await api.get(`/v1/assets/tasks/${taskId}/result`);
          urls[outputRes.data.assetId] = outputRes.data.downloadUrl;
        } catch (err) {
          console.error(`Failed to get output URL for task ${taskId}:`, err);
        }
      }

      setMediaUrls(urls);
    } catch (error) {
      console.error('Failed to fetch task detail:', error);
      alert('获取任务详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { label: string; color: string }> = {
      pending: { label: '等待中', color: 'bg-gray-100 text-gray-700' },
      processing: { label: '生成中', color: 'bg-blue-100 text-blue-700' },
      completed: { label: '已完成', color: 'bg-green-100 text-green-700' },
      failed: { label: '失败', color: 'bg-red-100 text-red-700' },
    };
    const info = statusMap[status] || { label: status, color: 'bg-gray-100 text-gray-700' };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${info.color}`}>
        {info.label}
      </span>
    );
  };

  const renderMediaPreview = (assetId: string, mimeType?: string, role?: string) => {
    const url = mediaUrls[assetId];
    if (!url) {
      return <div className="w-full h-48 bg-gray-100 rounded flex items-center justify-center">加载中...</div>;
    }

    const isVideo = mimeType?.startsWith('video/');
    const isImage = mimeType?.startsWith('image/');

    if (isVideo) {
      return (
        <video
          src={url}
          controls
          className="w-full rounded"
          style={{ maxHeight: '400px' }}
        />
      );
    } else if (isImage) {
      return (
        <img
          src={url}
          alt={role || 'Media'}
          className="w-full rounded"
          style={{ maxHeight: '400px', objectFit: 'contain' }}
        />
      );
    } else {
      return <div className="text-sm text-gray-500">不支持的媒体类型: {mimeType}</div>;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-gray-800">任务历史</h1>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 左侧：任务列表 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">任务列表</h2>

            {loading ? (
              <div className="text-center py-8">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-8 text-gray-500">暂无任务</div>
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => fetchTaskDetail(task.id)}
                    className={`p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition ${
                      selectedTask?.task.id === task.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1">
                        <div className="font-medium text-gray-800">{task.workflowName || '未知工作流'}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {new Date(task.createdAt).toLocaleString('zh-CN')}
                        </div>
                      </div>
                      {getStatusBadge(task.status)}
                    </div>
                    <div className="text-sm text-gray-600 line-clamp-2">{task.promptPreview}</div>
                    {task.cost.settled && (
                      <div className="text-xs text-gray-500 mt-2">成本: ¥{task.cost.settled}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-6">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  上一页
                </button>
                <span className="px-4 py-2">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page === totalPages}
                  className="px-4 py-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  下一页
                </button>
              </div>
            )}
          </div>

          {/* 右侧：任务详情 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">任务详情</h2>

            {!selectedTask ? (
              <div className="text-center py-16 text-gray-500">
                ← 点击左侧任务查看详情
              </div>
            ) : detailLoading ? (
              <div className="text-center py-16">加载中...</div>
            ) : (
              <div className="space-y-6">
                {/* 工作流信息 */}
                <div>
                  <h3 className="font-semibold text-gray-700 mb-2">🔧 工作流</h3>
                  <div className="text-sm space-y-1">
                    <div><span className="text-gray-600">名称:</span> {selectedTask.submissionDetails.workflow.name}</div>
                    <div><span className="text-gray-600">Key:</span> <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{selectedTask.submissionDetails.workflow.key}</code></div>
                  </div>
                </div>

                {/* 提示词 */}
                <div>
                  <h3 className="font-semibold text-gray-700 mb-2">📝 提示词</h3>
                  <div className="text-sm bg-gray-50 p-3 rounded whitespace-pre-wrap">
                    {selectedTask.submissionDetails.prompt.text}
                  </div>
                </div>

                {/* 生成参数 */}
                <div>
                  <h3 className="font-semibold text-gray-700 mb-2">⚙️ 生成参数</h3>
                  <div className="text-sm space-y-1">
                    {selectedTask.submissionDetails.generation.duration && (
                      <div><span className="text-gray-600">时长:</span> {selectedTask.submissionDetails.generation.duration}秒</div>
                    )}
                    {selectedTask.submissionDetails.generation.resolution && (
                      <div><span className="text-gray-600">分辨率:</span> {selectedTask.submissionDetails.generation.resolution}</div>
                    )}
                    {selectedTask.submissionDetails.generation.ratio && (
                      <div><span className="text-gray-600">比例:</span> {selectedTask.submissionDetails.generation.ratio}</div>
                    )}
                    {selectedTask.submissionDetails.generation.model && (
                      <div><span className="text-gray-600">模型:</span> {selectedTask.submissionDetails.generation.model}</div>
                    )}
                  </div>
                </div>

                {/* 输入媒体 */}
                {selectedTask.submissionDetails.media.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-700 mb-2">🖼️ 输入媒体</h3>
                    <div className="space-y-4">
                      {selectedTask.submissionDetails.media.map((media, index) => (
                        <div key={media.assetId}>
                          <div className="text-xs text-gray-500 mb-1">
                            {media.role} ({media.mimeType})
                          </div>
                          {renderMediaPreview(media.assetId, media.mimeType, media.role)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 输出视频 */}
                {selectedTask.task.deliveryStatus === 'ready' && (
                  <div>
                    <h3 className="font-semibold text-gray-700 mb-2">🎬 生成结果</h3>
                    {selectedTask.assets
                      .filter((asset) => asset.role === 'output')
                      .map((asset) => (
                        <div key={asset.assetId}>
                          {renderMediaPreview(asset.assetId, asset.mimeType || undefined, 'output')}
                        </div>
                      ))}
                  </div>
                )}

                {/* 错误信息 */}
                {selectedTask.task.errorMsg && (
                  <div>
                    <h3 className="font-semibold text-red-600 mb-2">❌ 错误信息</h3>
                    <div className="text-sm bg-red-50 text-red-700 p-3 rounded">
                      {selectedTask.task.errorMsg}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
