'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import api from '@/lib/api';
import { showcaseRoutes } from '@/lib/api-routes';

interface ShowcaseTask {
  id: string;
  creatorName: string;
  workflowName: string | null;
  status: string;
  promptPreview: string;
  parameters: {
    duration?: number;
    resolution?: string;
    ratio?: string;
    model?: string;
  };
  completedAt: string | null;
  hasOutput: boolean;
  outputAssetId?: string;
}

interface VideoPreview {
  downloadUrl: string;
  expiresIn: number;
}

interface ShowcaseResponse {
  tasks: ShowcaseTask[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export default function ShowcasePage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ShowcaseTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [videoUrls, setVideoUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetchShowcaseTasks();
  }, [page]);

  const fetchShowcaseTasks = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<ShowcaseResponse>(showcaseRoutes.list, {
        params: { page, limit: 12 },
      });

      setTasks(response.data.tasks);
      setTotalPages(response.data.pagination.totalPages);
      setTotal(response.data.pagination.total);

      const urls = new Map<string, string>();
      await Promise.all(
        response.data.tasks
          .filter(task => task.outputAssetId)
          .map(async (task) => {
            try {
              const videoResponse = await api.get<VideoPreview>(
                showcaseRoutes.video(task.outputAssetId!)
              );
              urls.set(task.outputAssetId!, videoResponse.data.downloadUrl);
            } catch (err) {
              console.error(`Failed to fetch video for asset ${task.outputAssetId}:`, err);
            }
          })
      );
      setVideoUrls(urls);
    } catch (err: any) {
      console.error('Failed to fetch showcase tasks:', err);
      setError('案例广场功能暂未完全就绪，敬请期待');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-2xl w-full p-8 text-center">
          <div className="mb-6">
            <svg className="mx-auto h-16 w-16 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h1 className="text-3xl font-normal mb-4">案例广场</h1>
          <p className="text-lg text-muted-foreground mb-6">{error}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="mb-8">
          <p className="eyebrow mb-2">SHOWCASE</p>
          <h1 className="text-3xl font-normal mb-2">案例广场</h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>浏览团队成员的优秀视频生成案例</span>
            {total > 0 && (
              <>
                <Separator orientation="vertical" className="h-4" />
                <span>{total} 个案例</span>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="text-muted-foreground">加载中...</div>
          </div>
        ) : (
          <>
            <div className="columns-1 sm:columns-2 lg:columns-3 gap-6">
              {tasks.map((task) => (
                <Card
                  key={task.id}
                  className="mb-6 cursor-pointer break-inside-avoid overflow-hidden transition-colors hover:bg-accent"
                  onClick={() => router.push(`/showcase/${task.id}`)}
                >
                  {task.outputAssetId && (
                    <div className="relative ">
                      {videoUrls.has(task.outputAssetId) ? (
                        <video src={videoUrls.get(task.outputAssetId)} className="w-full h-auto" preload="metadata" playsInline muted />
                      ) : (
                        <div className="w-full aspect-video flex items-center justify-center">
                          <svg className="w-16 h-16 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      )}
                      {task.parameters.duration && (
                        <Badge className="absolute bottom-2 right-2 bg-foreground/75 text-primary-foreground border-0">{task.parameters.duration}s</Badge>
                      )}
                    </div>
                  )}
                  <CardHeader>
                    <div className="flex items-center gap-3 mb-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-primary-foreground text-xs font-normal">
                          {task.creatorName.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-normal">{task.creatorName}</span>
                      {task.workflowName && <Badge variant="outline" className="ml-auto text-xs">{task.workflowName}</Badge>}
                    </div>
                    <CardTitle className="text-base line-clamp-2 leading-snug">{task.promptPreview || '无提示词'}</CardTitle>
                    <div className="flex items-center gap-2 text-xs flex-wrap mt-3 text-muted-foreground">
                      {task.parameters.model && <span>{task.parameters.model}</span>}
                      {task.parameters.resolution && (
                        <>
                          <Separator orientation="vertical" className="h-3" />
                          <span>{task.parameters.resolution}</span>
                        </>
                      )}
                      {task.parameters.ratio && (
                        <>
                          <Separator orientation="vertical" className="h-3" />
                          <span>{task.parameters.ratio}</span>
                        </>
                      )}
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {tasks.length === 0 && (
              <div className="text-center py-12">
                <p className="text-muted-foreground">暂无案例展示</p>
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-8">
                <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>上一页</Button>
                <span className="flex items-center px-4 text-sm text-muted-foreground">第 {page} / {totalPages} 页</span>
                <Button variant="outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>下一页</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
