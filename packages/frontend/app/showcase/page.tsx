'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@appica/ui-react/card';
import { Badge } from '@appica/ui-react/badge';
import { Button } from '@appica/ui-react/button';
import { Spinner } from '@appica/ui-react/spinner';
import api from '@/lib/api';

interface ShowcaseTask {
  id: string;
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
  const [tasks, setTasks] = useState<ShowcaseTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    fetchShowcaseTasks();
  }, [page]);

  const fetchShowcaseTasks = async () => {
    setLoading(true);
    setError(null);

    try {
      // 暂时使用通用任务列表接口，只显示已完成且有输出的任务
      const response = await api.get<ShowcaseResponse>('/api/v1/showcase/tasks', {
        params: { page, limit: 12 },
      });

      setTasks(response.data.tasks);
      setTotalPages(response.data.pagination.totalPages);
    } catch (err: any) {
      // 如果showcase接口不可用，显示友好提示
      console.error('Failed to fetch showcase tasks:', err);
      setError('案例广场功能暂未完全就绪，敬请期待');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-2xl mx-auto">
            <Card className="p-8 text-center">
              <div className="mb-6">
                <svg
                  className="mx-auto h-16 w-16 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>

              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                案例广场
              </h1>

              <p className="text-lg text-gray-600 dark:text-gray-300 mb-6">
                {error}
              </p>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 text-left">
                <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                  即将推出的功能
                </h3>
                <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-2">
                  <li>• 查看团队成员的已完成视频生成案例</li>
                  <li>• 学习和参考其他成员的提示词和参数配置</li>
                  <li>• 促进团队协作和知识共享</li>
                </ul>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            案例广场
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            浏览团队成员的优秀视频生成案例
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Spinner size="lg" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              {tasks.map((task) => (
                <Card key={task.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="flex justify-between items-start mb-2">
                      <Badge variant={task.status === 'completed' ? 'success' : 'default'}>
                        {task.status}
                      </Badge>
                      {task.workflowName && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {task.workflowName}
                        </span>
                      )}
                    </div>
                    <CardTitle className="text-lg line-clamp-2">
                      {task.promptPreview || '无提示词'}
                    </CardTitle>
                    <CardDescription>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {task.parameters.model && (
                          <Badge variant="outline">{task.parameters.model}</Badge>
                        )}
                        {task.parameters.duration && (
                          <Badge variant="outline">{task.parameters.duration}s</Badge>
                        )}
                        {task.parameters.resolution && (
                          <Badge variant="outline">{task.parameters.resolution}</Badge>
                        )}
                      </div>
                    </CardDescription>
                  </CardHeader>
                  <CardFooter className="flex justify-between items-center">
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {task.completedAt
                        ? new Date(task.completedAt).toLocaleDateString('zh-CN')
                        : '进行中'}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => window.location.href = `/history?taskId=${task.id}`}>
                      查看详情
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>

            {tasks.length === 0 && (
              <div className="text-center py-12">
                <p className="text-gray-500 dark:text-gray-400">暂无案例展示</p>
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  上一页
                </Button>
                <span className="flex items-center px-4">
                  第 {page} / {totalPages} 页
                </span>
                <Button
                  variant="outline"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
