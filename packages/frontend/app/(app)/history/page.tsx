'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@appica/ui-react/card';
import { Badge } from '@appica/ui-react/badge';
import { Button } from '@appica/ui-react/button';
import { Spinner } from '@appica/ui-react/spinner';

// Types
interface Task {
  id: string;
  workflowKey: string | null;
  workflowName: string | null;
  status: string;
  deliveryStatus: string | null;
  parameters: {
    duration: number;
    resolution: string;
    ratio: string;
    model: string;
  };
  promptPreview: string;
  cost: {
    reserved: string;
    settled: string | null;
    status: string;
  };
  createdAt: string;
  completedAt: string | null;
  hasOutput: boolean;
  outputReady: boolean;
}

interface TaskDetail {
  id: string;
  status: string;
  deliveryStatus: string | null;
  errorMessage: string | null;
  submissionDetails: {
    workflow: {
      key: string;
      name: string;
      version: string;
    };
    prompt: {
      text: string;
    };
    generation: {
      model: string;
      duration: number;
      resolution: string;
      ratio: string;
      outputFormat: string;
      generateAudio: boolean;
      watermark: boolean;
    };
    media: Array<{
      role: string;
      assetId: string;
      mimeType: string;
      sizeBytes: number;
      metadata?: {
        kind: string;
        width?: number;
        height?: number;
        duration?: number;
      };
    }>;
  };
  assets: Array<{
    id: string;
    role: string;
    mediaType: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  createdAt: string;
  completedAt: string | null;
}

interface TokenInfo {
  dailyLimit: number;
  dailyUsed: number;
  monthlyLimit: number;
  monthlyUsed: number;
}

interface TokenLogsResponse {
  logs: Array<{
    id: string;
    timestamp: string;
    amount: number;
    description: string;
  }>;
}

interface MediaPreviewProps {
  assetId: string;
  mimeType: string;
  role: string;
}

function MediaPreview({ assetId, mimeType, role }: MediaPreviewProps) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMedia = async () => {
      try {
        const token = localStorage.getItem('token');
        console.log('Fetching media:', { assetId, mimeType, role });

        const response = await fetch(`http://localhost:3001/api/v1/assets/${assetId}/download`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        console.log('Media response:', response.status);

        if (response.ok) {
          const data = await response.json();
          console.log('Media URL obtained:', data.downloadUrl ? 'yes' : 'no');
          setMediaUrl(data.downloadUrl);
        } else {
          const errorText = await response.text();
          console.error('Failed to fetch media:', response.status, errorText);
          setError(`加载失败: ${response.status}`);
        }
      } catch (error) {
        console.error('Failed to fetch media:', error);
        setError(`网络错误: ${error}`);
      } finally {
        setLoading(false);
      }
    };

    fetchMedia();
  }, [assetId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 bg-gray-50 rounded-lg">
        <Spinner />
      </div>
    );
  }

  if (error || !mediaUrl) {
    return (
      <div className="flex items-center justify-center h-32 bg-gray-50 rounded-lg text-gray-400">
        {error || '无法加载'}
      </div>
    );
  }

  if (mimeType.startsWith('image/')) {
    return <img src={mediaUrl} alt={role} className="w-full rounded-lg" />;
  }

  if (mimeType.startsWith('video/')) {
    return <video src={mediaUrl} controls className="w-full rounded-lg" />;
  }

  if (mimeType.startsWith('audio/')) {
    return <audio src={mediaUrl} controls className="w-full" />;
  }

  return (
    <div className="flex items-center justify-center h-32 bg-gray-50 rounded-lg text-gray-400">
      {mimeType}
    </div>
  );
}

function getStatusBadge(status: string) {
  const variants = {
    completed: { variant: 'success' as const, label: '已完成' },
    failed: { variant: 'error' as const, label: '失败' },
    preview: { variant: 'info' as const, label: '预览' },
    pending: { variant: 'warning' as const, label: '进行中' },
  };

  const config = variants[status as keyof typeof variants] || { variant: 'soft' as const, label: status };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export default function HistoryPageAppica() {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [logs, setLogs] = useState<TokenLogsResponse | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  useEffect(() => {
    fetchTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      console.log('Token from localStorage:', token);

      if (!token) {
        setError('请先登录');
        setLoading(false);
        return;
      }

      console.log('Fetching tasks from:', `http://localhost:3001/api/v1/tasks?page=${page}&limit=20`);

      const response = await fetch(`http://localhost:3001/api/v1/tasks?page=${page}&limit=20`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('Response status:', response.status, response.statusText);

      if (response.ok) {
        const data = await response.json();
        console.log('Tasks loaded:', data.tasks.length, 'Total pages:', data.pagination.totalPages);
        setTasks(data.tasks);
        setTotalPages(data.pagination.totalPages);
        setError(null);

        // Auto-select first task
        if (data.tasks.length > 0 && !selectedTask) {
          fetchTaskDetail(data.tasks[0].id);
        }
      } else {
        const errorText = await response.text();
        console.error('API Error:', response.status, errorText);
        setError(`加载失败: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('Fetch error:', error);
      setError(`网络错误: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchTaskDetail = async (taskId: string) => {
    setDetailLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`http://localhost:3001/api/v1/tasks/${taskId}/detail`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedTask(data);
      }
    } catch (error) {
      console.error('Failed to fetch task detail:', error);
    } finally {
      setDetailLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Card frame="solid">
          <CardHeader>
            <CardTitle>❌ 错误</CardTitle>
          </CardHeader>
          <div className="px-6 pb-6">
            <p className="text-red-600 mb-4">{error}</p>
            <Button onClick={() => window.location.href = '/login'}>前往登录</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full h-screen flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="container mx-auto px-6 py-6 flex flex-col h-full">
        <div className="mb-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                任务历史
              </h1>
              <p className="text-sm text-gray-500 mt-1">查看您的视频生成历史记录</p>
            </div>
            <div className="text-sm text-gray-400">
              共 {totalPages} 页 · {tasks.length > 0 ? `${tasks.length} 条记录` : '暂无记录'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 overflow-hidden min-h-0">
        {/* Left: Task List */}
        <div className="flex flex-col overflow-y-auto pr-2 -mr-2">
          {tasks.length === 0 ? (
            <div className="pl-1 pr-2 pt-1">
              <Card frame="solid">
                <div className="flex items-center justify-center h-32 text-gray-400">
                  暂无任务记录
                </div>
              </Card>
            </div>
          ) : (
            <div className="space-y-2 pl-1 pr-2 pt-1 pb-4">{tasks.map((task) => (
              <Card
                key={task.id}
                frame="glass"
                className={`cursor-pointer transition-all duration-200 hover:shadow-md bg-white ml-1 mr-1 ${
                  selectedTask?.id === task.id
                    ? 'ring-2 ring-blue-500 shadow-md'
                    : 'hover:ring-1 hover:ring-blue-200'
                }`}
                contentProps={{
                  onClick: () => fetchTaskDetail(task.id),
                }}
              >
                <div className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-800 truncate">
                        {task.workflowName || '未知工作流'}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {new Date(task.createdAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    {getStatusBadge(task.status)}
                  </div>
                  <p className="text-xs text-gray-600 line-clamp-2 leading-relaxed mb-2">
                    {task.promptPreview}
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">💰 ¥{task.cost.reserved}</span>
                    {task.hasOutput && (
                      <span className="text-green-600 text-xs">✓ 已生成</span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
            </div>
          )}

          {/* Pagination */}
          <div className="flex justify-center gap-2 pb-4 pl-1 pr-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              className="transition-all hover:scale-105"
            >
              ← 上一页
            </Button>
            <span className="px-4 py-2 text-sm font-medium bg-white rounded-lg shadow-sm">
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage(page + 1)}
              className="transition-all hover:scale-105"
            >
              下一页 →
            </Button>
          </div>
        </div>

        {/* Right: Task Detail */}
        <div className="flex flex-col overflow-y-auto pr-2 -mr-2 pl-1">
          {detailLoading ? (
            <Card frame="solid">
              <div className="flex items-center justify-center h-64">
                <Spinner />
              </div>
            </Card>
          ) : selectedTask ? (
            <div className="space-y-4 pb-6">
              {/* 主体：生成结果视频 */}
              {selectedTask.status === 'completed' && selectedTask.assets.length > 0 && (
                <Card frame="solid" className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white shadow-lg">
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <span className="text-2xl">🎬</span>
                      <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                        生成结果
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-6">
                    {selectedTask.assets
                      .filter((asset) => asset.role === 'output')
                      .map((asset) => (
                        <div key={asset.id} className="rounded-xl overflow-hidden shadow-xl">
                          <MediaPreview
                            assetId={asset.id}
                            mimeType={asset.mimeType}
                            role={asset.role}
                          />
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* 错误信息 */}
              {selectedTask.status === 'failed' && selectedTask.errorMessage && (
                <Card frame="solid" className="border-2 border-red-200 bg-gradient-to-br from-red-50 to-white shadow-lg">
                  <CardHeader>
                    <CardTitle className="text-lg text-red-700 flex items-center gap-2">
                      <span className="text-2xl">❌</span>
                      <span>错误信息</span>
                    </CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-6">
                    <div className="bg-red-100 border border-red-200 rounded-lg p-4">
                      <p className="text-sm text-red-700 leading-relaxed">{selectedTask.errorMessage}</p>
                    </div>
                  </div>
                </Card>
              )}

              {/* 关键信息：提示词 */}
              <Card frame="solid" className="bg-white shadow-md">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2 text-gray-700">
                      <span className="text-xl">📝</span>
                      <span>提示词</span>
                    </CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(selectedTask.submissionDetails.prompt.text)}
                      className="flex items-center gap-1 text-xs transition-all hover:scale-105"
                    >
                      {copied ? (
                        <>
                          <span>✓</span>
                          <span>已复制</span>
                        </>
                      ) : (
                        <>
                          <span>📋</span>
                          <span>复制</span>
                        </>
                      )}
                    </Button>
                  </div>
                </CardHeader>
                <div className="px-6 pb-6">
                  <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-lg p-4 relative group">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed text-gray-700">
                      {selectedTask.submissionDetails.prompt.text}
                    </p>
                  </div>
                </div>
              </Card>

              {/* 次要信息区域 - 视觉弱化 */}
              <div className="space-y-3 opacity-75">
                {/* 生成参数 - 精简显示 */}
                <Card frame="glass" className="bg-white/50 backdrop-blur-sm">
                  <CardHeader>
                    <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
                      <span>⚙️</span>
                      <span>生成参数</span>
                    </CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-4">
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="bg-gradient-to-r from-blue-100 to-blue-50 border border-blue-200 px-3 py-1.5 rounded-full font-medium text-blue-700">
                        {selectedTask.submissionDetails.generation.model}
                      </span>
                      <span className="bg-gradient-to-r from-green-100 to-green-50 border border-green-200 px-3 py-1.5 rounded-full font-medium text-green-700">
                        ⏱️ {selectedTask.submissionDetails.generation.duration}秒
                      </span>
                      <span className="bg-gradient-to-r from-purple-100 to-purple-50 border border-purple-200 px-3 py-1.5 rounded-full font-medium text-purple-700">
                        📐 {selectedTask.submissionDetails.generation.resolution}
                      </span>
                      <span className="bg-gradient-to-r from-orange-100 to-orange-50 border border-orange-200 px-3 py-1.5 rounded-full font-medium text-orange-700">
                        🎞️ {selectedTask.submissionDetails.generation.ratio}
                      </span>
                    </div>
                  </div>
                </Card>

                {/* 输入媒体 */}
                {selectedTask.submissionDetails.media.length > 0 && (
                  <Card frame="glass" className="bg-white/50 backdrop-blur-sm">
                    <CardHeader>
                      <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
                        <span>🖼️</span>
                        <span>输入媒体</span>
                      </CardTitle>
                    </CardHeader>
                    <div className="px-6 pb-4 space-y-3">
                      {selectedTask.submissionDetails.media.map((media, idx) => (
                        <div key={idx}>
                          <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                            <span className="font-medium">{media.role}</span>
                            <span className="text-gray-400">({media.mimeType})</span>
                          </p>
                          <div className="rounded-lg overflow-hidden shadow-md">
                            <MediaPreview
                              assetId={media.assetId}
                              mimeType={media.mimeType}
                              role={media.role}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* 工作流信息 - 最次要 */}
                <details className="group">
                  <summary className="cursor-pointer list-none">
                    <Card frame="glass" className="group-open:mb-2 bg-white/30 hover:bg-white/50 transition-all">
                      <div className="px-6 py-3 flex items-center justify-between">
                        <span className="text-xs text-gray-500 flex items-center gap-2">
                          <span>🔧</span>
                          <span>工作流详情</span>
                        </span>
                        <span className="text-xs text-gray-400 group-open:rotate-180 transition-transform duration-200">
                          ▼
                        </span>
                      </div>
                    </Card>
                  </summary>
                  <Card frame="glass" className="bg-white/50">
                    <div className="px-6 py-4 space-y-2 text-xs">
                      <div className="flex items-start gap-2">
                        <span className="text-gray-500 min-w-[48px]">名称：</span>
                        <span className="font-medium text-gray-700">{selectedTask.submissionDetails.workflow.name}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-gray-500 min-w-[48px]">Key：</span>
                        <span className="font-mono text-gray-600 break-all">{selectedTask.submissionDetails.workflow.key}</span>
                      </div>
                    </div>
                  </Card>
                </details>
              </div>
            </div>
          ) : (
            <Card frame="solid">
              <div className="flex items-center justify-center h-64 text-gray-400">
                请选择一个任务查看详情
              </div>
            </Card>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
