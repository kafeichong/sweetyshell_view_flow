'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import api from '@/lib/api';
import { showcaseRoutes } from '@/lib/api-routes';
import { writeClipboardText } from '@/lib/clipboard';
import { ArrowLeft, Check, Copy } from 'lucide-react';

interface TaskDetail {
  id: string;
  creatorName: string;
  workflowName: string;
  status: string;
  prompt: string;
  parameters: {
    duration?: number;
    resolution?: string;
    ratio?: string;
    model?: string;
  };
  hasOutput: boolean;
  outputAsset?: {
    id: string;
    downloadUrl: string;
    mimeType: string;
    sizeBytes: number;
    expiresIn: number;
  };
  createdAt: string;
  completedAt: string | null;
}

export default function ShowcaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.taskId as string;

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  useEffect(() => {
    fetchTaskDetail();
  }, [taskId]);

  const fetchTaskDetail = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<TaskDetail>(showcaseRoutes.detail(taskId));
      setTask(response.data);
    } catch (err: any) {
      console.error('Failed to fetch task detail:', err);
      setError(err.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const copyPrompt = async () => {
    if (!task) return;

    try {
      await writeClipboardText(task.prompt, navigator.clipboard);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy showcase prompt:', err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-2xl w-full p-8 text-center">
          <p className="text-lg text-muted-foreground mb-4">
            {error || '案例不存在'}
          </p>
          <Button onClick={() => router.push('/showcase')}>
            返回案例广场
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <Button
          variant="ghost"
          onClick={() => router.push('/showcase')}
          className="mb-6"
        >
          <ArrowLeft className="size-4" />返回案例广场
        </Button>

        <div className="grid lg:grid-cols-2 gap-8">
          <div className="lg:sticky lg:top-8 lg:self-start">
            {task.outputAsset && (
              <Card className="overflow-hidden border-border ">
                <video
                  src={task.outputAsset.downloadUrl}
                  controls
                  className="w-full h-auto bg-foreground"
                  preload="metadata"
                  playsInline
                />
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card className="border-border bg-card">
              <CardHeader className="border-b bg-muted/50">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <p className="eyebrow">
                    {task.workflowName || '未知工作流'}
                    </p>
                    <Badge variant={task.status === 'completed' ? 'default' : 'secondary'}>
                      {task.status === 'completed' ? '已完成' : task.status}
                    </Badge>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border bg-background p-3">
                    <CardTitle className="min-w-0 flex-1 whitespace-pre-wrap break-words text-base leading-relaxed">
                      {task.prompt}
                    </CardTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label={promptCopied ? '提示词已复制' : '复制提示词'}
                      title={promptCopied ? '已复制' : '复制提示词'}
                      onClick={() => void copyPrompt()}
                    >
                      {promptCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{task.creatorName}</span>
                  <Separator orientation="vertical" className="h-4" />
                  <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-card">
              <CardHeader className="border-b bg-muted/50">
                <CardTitle className="text-base">生成参数</CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="grid grid-cols-2 gap-4">
                  {task.parameters.model && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">模型</div>
                      <div className="font-normal">{task.parameters.model}</div>
                    </div>
                  )}
                  {task.parameters.duration && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">时长</div>
                      <div className="font-normal">{task.parameters.duration}s</div>
                    </div>
                  )}
                  {task.parameters.resolution && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">分辨率</div>
                      <div className="font-normal">{task.parameters.resolution}</div>
                    </div>
                  )}
                  {task.parameters.ratio && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">比例</div>
                      <div className="font-normal">{task.parameters.ratio}</div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {task.completedAt && (
              <Card className="border-border bg-card">
                <CardHeader className="border-b bg-muted/50">
                  <CardTitle className="text-base">时间信息</CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">创建时间</span>
                    <span className="font-normal">
                      {new Date(task.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <Separator className="my-3" />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">完成时间</span>
                    <span className="font-normal">
                      {new Date(task.completedAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
