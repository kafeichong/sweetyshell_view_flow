'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Film, Settings2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataPagination } from '@/components/data-pagination';
import { PageHeader } from '@/components/page-header';
import { PageState } from '@/components/page-state';
import { StatusBadge } from '@/components/status-badge';
import { writeClipboardText } from '@/lib/clipboard';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3100/api';

function Spinner() {
  return <div className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
}

function CopyableWorkflowName({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await writeClipboardText(value, navigator.clipboard);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy workflow name:', err);
    }
  };

  return (
    <div className="flex h-9 min-w-0 items-center rounded-md border bg-muted/40 pl-3 text-sm">
      <h2 className="min-w-0 flex-1 truncate font-normal" title={value}>{value}</h2>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={copied ? `已复制：${value}` : `复制工作流名称：${value}`}
        title={copied ? '已复制' : '复制'}
        onClick={(event) => {
          event.stopPropagation();
          void handleCopy();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMedia = async () => {
      try {
        const token = localStorage.getItem('auth_token');
        console.log('Fetching media:', { assetId, mimeType, role });

        const response = await fetch(`${API_BASE_URL}/v1/assets/${assetId}/download`, {
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
  }, [assetId, mimeType, role]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 bg-muted rounded-md">
        <Spinner />
      </div>
    );
  }

  if (error || !mediaUrl) {
    return (
      <div className="flex items-center justify-center h-32 bg-muted rounded-md text-muted-foreground">
        {error || '无法加载'}
      </div>
    );
  }

  if (mimeType.startsWith('image/')) {
    return <img src={mediaUrl} alt={role} className="w-full rounded-md" />;
  }

  if (mimeType.startsWith('video/')) {
    return <video src={mediaUrl} controls className="w-full rounded-md" />;
  }

  if (mimeType.startsWith('audio/')) {
    return <audio src={mediaUrl} controls className="w-full" />;
  }

  return (
    <div className="flex items-center justify-center h-32 bg-muted rounded-md text-muted-foreground">
      {mimeType}
    </div>
  );
}

export default function HistoryPage() {
  const router = useRouter();
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

  async function fetchTasks() {
    setLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        setError('请先登录');
        setLoading(false);
        return;
      }

      console.log('Fetching tasks from:', `${API_BASE_URL}/v1/tasks?page=${page}&limit=20`);

      const response = await fetch(`${API_BASE_URL}/v1/tasks?page=${page}&limit=20`, {
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
  }

  async function fetchTaskDetail(taskId: string) {
    setDetailLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(`${API_BASE_URL}/v1/tasks/${taskId}/detail`, {
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
  }

  useEffect(() => {
    const request = window.setTimeout(() => void fetchTasks(), 0);
    // The selected task is intentionally preserved while paging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => window.clearTimeout(request);
  }, [page]);

  if (loading) {
    return <PageState kind="loading" title="正在加载任务历史" />;
  }

  if (error) {
    return (
      <PageState
        kind="error"
        title="任务历史加载失败"
        description={error}
        action={<Button onClick={() => router.push('/login')}>前往登录</Button>}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <PageHeader
        title="任务历史"
        description="查看视频生成任务、输出结果和提交参数。"
        actions={<Badge variant="outline">共 {tasks.length} 条</Badge>}
      />

      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
        <section className="flex min-h-0 flex-col gap-4" aria-label="任务列表">
          {tasks.length === 0 ? (
            <PageState kind="empty" title="暂无任务记录" description="完成一次视频生成后，任务会显示在这里。" />
          ) : (
            <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {tasks.map((task) => (
                <Card
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  data-state={selectedTask?.id === task.id ? 'selected' : undefined}
                  className="cursor-pointer transition-colors hover:bg-accent data-[state=selected]:border-foreground data-[state=selected]:bg-accent"
                  onClick={() => fetchTaskDetail(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') fetchTaskDetail(task.id);
                  }}
                >
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {task.workflowName ? (
                          <CopyableWorkflowName value={task.workflowName} />
                        ) : (
                          <h2 className="h-9 truncate px-3 py-2 text-sm font-normal text-muted-foreground">未知工作流</h2>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {new Date(task.createdAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <StatusBadge status={task.status} />
                    </div>
                    <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{task.promptPreview}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>预占 ¥{task.cost.reserved}</span>
                      {task.hasOutput ? <span>已有输出</span> : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <DataPagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </section>

        <section className="min-h-0 overflow-y-auto" aria-label="任务详情">
          {detailLoading ? (
            <PageState kind="loading" title="正在加载任务详情" />
          ) : selectedTask ? (
            <div className="space-y-4">
              {selectedTask.status === 'completed' && selectedTask.assets.length > 0 && (
                <Card>
                  <CardHeader className="border-b bg-muted/50">
                    <CardTitle className="flex items-center gap-2 text-base"><Film className="size-4" />生成结果</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-6">
                    {selectedTask.assets
                      .filter((asset) => asset.role === 'output')
                      .map((asset) => (
                        <MediaPreview key={asset.id} assetId={asset.id} mimeType={asset.mimeType} role={asset.role} />
                      ))}
                  </CardContent>
                </Card>
              )}

              {selectedTask.status === 'failed' && selectedTask.errorMessage && (
                <PageState kind="error" title="任务执行失败" description={selectedTask.errorMessage} />
              )}

              <Card>
                <CardHeader className="border-b bg-muted/50">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">提示词</CardTitle>
                    <Button variant="outline" size="sm" onClick={() => copyToClipboard(selectedTask.submissionDetails.prompt.text)}>
                      <Copy className="size-4" />{copied ? '已复制' : '复制'}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selectedTask.submissionDetails.prompt.text}</p></CardContent>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader className="border-b bg-muted/50">
                    <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="size-4" />生成参数</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-6">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{selectedTask.submissionDetails.generation.model}</Badge>
                      <Badge variant="outline">{selectedTask.submissionDetails.generation.duration} 秒</Badge>
                      <Badge variant="outline">{selectedTask.submissionDetails.generation.resolution}</Badge>
                      <Badge variant="outline">{selectedTask.submissionDetails.generation.ratio}</Badge>
                    </div>
                  </CardContent>
                </Card>

                {selectedTask.submissionDetails.media.length > 0 && (
                  <Card>
                    <CardHeader className="border-b bg-muted/50">
                      <CardTitle className="text-base">输入媒体</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 pt-6">
                      {selectedTask.submissionDetails.media.map((media, idx) => (
                        <div key={`${media.assetId}-${idx}`} className="space-y-2">
                          <p className="text-xs text-muted-foreground">{media.role} · {media.mimeType}</p>
                          <MediaPreview assetId={media.assetId} mimeType={media.mimeType} role={media.role} />
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                <details className="group overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm">
                  <summary className="cursor-pointer bg-muted/50 px-6 py-4 text-sm font-normal">工作流详情</summary>
                  <div className="space-y-2 border-t p-6 text-xs">
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground min-w-[48px]">名称：</span>
                        <span className="font-normal text-foreground">{selectedTask.submissionDetails.workflow.name}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground min-w-[48px]">Key：</span>
                        <span className="font-mono text-muted-foreground break-all">{selectedTask.submissionDetails.workflow.key}</span>
                      </div>
                  </div>
                </details>
              </div>
            </div>
          ) : (
            <PageState kind="empty" title="请选择任务" description="从左侧列表选择一项查看输出、提示词和生成参数。" />
          )}
        </section>
      </div>
    </div>
  );
}
