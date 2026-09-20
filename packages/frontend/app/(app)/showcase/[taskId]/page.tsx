'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import api from '@/lib/api';

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

  useEffect(() => {
    fetchTaskDetail();
  }, [taskId]);

  const fetchTaskDetail = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<TaskDetail>(`/api/v1/tasks/showcase/tasks/${taskId}`);
      setTask(response.data);
    } catch (err: any) {
      console.error('Failed to fetch task detail:', err);
      setError(err.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
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
          ← 返回案例广场
        </Button>

        <div className="grid lg:grid-cols-2 gap-8">
          <div className="lg:sticky lg:top-8 lg:self-start">
            {task.outputAsset && (
              <Card className="overflow-hidden border-purple-100 shadow-lg">
                <video
                  src={task.outputAsset.downloadUrl}
                  controls
                  className="w-full h-auto bg-black"
                  preload="metadata"
                  playsInline
                />
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card className="border-purple-100 bg-white/80 backdrop-blur-sm">
              <CardHeader>
                <div className="mb-4">
                  <p className="eyebrow mb-2">
                    {task.workflowName || '未知工作流'}
                  </p>
                  <div className="flex items-start justify-between gap-4">
                    <CardTitle className="text-2xl leading-tight flex-1">
                      {task.prompt}
                    </CardTitle>
                    <Badge variant={task.status === 'completed' ? 'default' : 'secondary'}>
                      {task.status === 'completed' ? '已完成' : task.status}
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{task.creatorName}</span>
                  <Separator orientation="vertical" className="h-4" />
                  <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
                </div>
              </CardHeader>
            </Card>

            <Card className="border-purple-100 bg-white/80 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="text-base">生成参数</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  {task.parameters.model && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">模型</div>
                      <div className="font-medium">{task.parameters.model}</div>
                    </div>
                  )}
                  {task.parameters.duration && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">时长</div>
                      <div className="font-medium">{task.parameters.duration}s</div>
                    </div>
                  )}
                  {task.parameters.resolution && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">分辨率</div>
                      <div className="font-medium">{task.parameters.resolution}</div>
                    </div>
                  )}
                  {task.parameters.ratio && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">比例</div>
                      <div className="font-medium">{task.parameters.ratio}</div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {task.completedAt && (
              <Card className="border-purple-100 bg-white/80 backdrop-blur-sm">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">创建时间</span>
                    <span className="font-medium">
                      {new Date(task.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <Separator className="my-3" />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">完成时间</span>
                    <span className="font-medium">
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
