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

interface MediaPreviewProps {
  assetId: string;
  mimeType: string;
  role: string;
}

function MediaPreview({ assetId, mimeType, role }: MediaPreviewProps) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMedia = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`http://localhost:3001/api/v1/assets/${assetId}/download`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setMediaUrl(data.downloadUrl);
        }
      } catch (error) {
        console.error('Failed to fetch media:', error);
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

  if (!mediaUrl) {
    return (
      <div className="flex items-center justify-center h-32 bg-gray-50 rounded-lg text-gray-400">
        无法加载
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    fetchTasks();
  }, [page]);

  const fetchTasks = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`http://localhost:3001/api/v1/tasks?page=${page}&limit=20`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setTasks(data.tasks);
        setTotalPages(data.pagination.totalPages);

        // Auto-select first task
        if (data.tasks.length > 0 && !selectedTask) {
          fetchTaskDetail(data.tasks[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
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

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">任务历史</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Task List */}
        <div className="space-y-4">
          <Card frame="solid">
            <CardHeader>
              <CardTitle>任务列表</CardTitle>
              <CardDescription>共 {totalPages} 页任务记录</CardDescription>
            </CardHeader>
          </Card>

          <div className="space-y-3">
            {tasks.map((task) => (
              <Card
                key={task.id}
                frame="glass"
                className={`cursor-pointer transition-all hover:shadow-md ${
                  selectedTask?.id === task.id ? 'ring-2 ring-blue-500' : ''
                }`}
                contentProps={{
                  onClick: () => fetchTaskDetail(task.id),
                }}
              >
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">
                      {task.workflowName || '未知工作流'}
                    </CardTitle>
                    {getStatusBadge(task.status)}
                  </div>
                  <CardDescription className="text-sm">
                    {new Date(task.createdAt).toLocaleString('zh-CN')}
                  </CardDescription>
                </CardHeader>
                <div className="px-6 pb-4">
                  <p className="text-sm text-gray-600 line-clamp-2">{task.promptPreview}</p>
                </div>
                <CardFooter>
                  <span className="text-xs text-gray-500">成本: ¥{task.cost.reserved}</span>
                </CardFooter>
              </Card>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <span className="px-4 py-2 text-sm">
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>

        {/* Right: Task Detail */}
        <div className="lg:sticky lg:top-6 h-fit">
          {detailLoading ? (
            <Card frame="solid">
              <div className="flex items-center justify-center h-64">
                <Spinner />
              </div>
            </Card>
          ) : selectedTask ? (
            <div className="space-y-4">
              {/* Workflow Info */}
              <Card frame="solid">
                <CardHeader>
                  <CardTitle>🔧 工作流</CardTitle>
                </CardHeader>
                <div className="px-6 pb-6 space-y-2">
                  <div>
                    <span className="text-sm text-gray-500">名称：</span>
                    <span className="text-sm font-medium">{selectedTask.submissionDetails.workflow.name}</span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">Key：</span>
                    <span className="text-sm font-mono">{selectedTask.submissionDetails.workflow.key}</span>
                  </div>
                </div>
              </Card>

              {/* Prompt */}
              <Card frame="solid">
                <CardHeader>
                  <CardTitle>📝 提示词</CardTitle>
                </CardHeader>
                <div className="px-6 pb-6">
                  <p className="text-sm whitespace-pre-wrap">{selectedTask.submissionDetails.prompt.text}</p>
                </div>
              </Card>

              {/* Generation Parameters */}
              <Card frame="solid">
                <CardHeader>
                  <CardTitle>⚙️ 生成参数</CardTitle>
                </CardHeader>
                <div className="px-6 pb-6 grid grid-cols-2 gap-3">
                  <div>
                    <span className="text-sm text-gray-500">时长：</span>
                    <span className="text-sm font-medium">{selectedTask.submissionDetails.generation.duration}秒</span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">分辨率：</span>
                    <span className="text-sm font-medium">{selectedTask.submissionDetails.generation.resolution}</span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">比例：</span>
                    <span className="text-sm font-medium">{selectedTask.submissionDetails.generation.ratio}</span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">模型：</span>
                    <span className="text-sm font-medium">{selectedTask.submissionDetails.generation.model}</span>
                  </div>
                </div>
              </Card>

              {/* Input Media */}
              {selectedTask.submissionDetails.media.length > 0 && (
                <Card frame="solid">
                  <CardHeader>
                    <CardTitle>🖼️ 输入媒体</CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-6 space-y-4">
                    {selectedTask.submissionDetails.media.map((media, idx) => (
                      <div key={idx}>
                        <p className="text-xs text-gray-500 mb-2">
                          {media.role} ({media.mimeType})
                        </p>
                        <MediaPreview
                          assetId={media.assetId}
                          mimeType={media.mimeType}
                          role={media.role}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Output Video */}
              {selectedTask.status === 'completed' && selectedTask.assets.length > 0 && (
                <Card frame="solid">
                  <CardHeader>
                    <CardTitle>🎬 生成结果</CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-6">
                    {selectedTask.assets
                      .filter((asset) => asset.role === 'output')
                      .map((asset) => (
                        <MediaPreview
                          key={asset.id}
                          assetId={asset.id}
                          mimeType={asset.mimeType}
                          role={asset.role}
                        />
                      ))}
                  </div>
                </Card>
              )}

              {/* Error Message */}
              {selectedTask.status === 'failed' && selectedTask.errorMessage && (
                <Card frame="solid">
                  <CardHeader>
                    <CardTitle>❌ 错误信息</CardTitle>
                  </CardHeader>
                  <div className="px-6 pb-6">
                    <p className="text-sm text-red-600">{selectedTask.errorMessage}</p>
                  </div>
                </Card>
              )}
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
  );
}
