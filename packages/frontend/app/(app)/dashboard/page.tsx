'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { ConsumptionOverview, ConsumptionTrendsResponse } from '@/types/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import TrendChart from '@/components/charts/TrendChart';
import { ChartNoAxesCombined, CircleCheck, CircleDollarSign, Info, TrendingUp, TriangleAlert } from 'lucide-react';

export default function DashboardPage() {
  const [overview, setOverview] = useState<ConsumptionOverview | null>(null);
  const [trends, setTrends] = useState<ConsumptionTrendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState(30);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // 检查登录模式
    const mode = localStorage.getItem('auth_mode');
    setIsAdmin(mode === 'admin');
    fetchData();
  }, [trendDays]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const mode = localStorage.getItem('auth_mode');

      if (mode === 'admin') {
        // 管理员模式：目前只显示提示信息
        setOverview({
          todayCny: '0.00',
          monthCny: '0.00',
          dailyLimit: undefined,
          monthlyLimit: undefined,
          alerts: {
            daily: { enabled: false, thresholdCny: '0', triggered: false },
            monthly: { enabled: false, thresholdCny: '0', triggered: false }
          }
        });
        setTrends({
          trends: [],
          summary: {
            totalCny: '0.00',
            avgDailyCny: '0.00',
            peakDayCny: '0.00',
            peakDayKey: '-'
          }
        });
      } else {
        // 用户模式：调用用户端点
        const [overviewRes, trendsRes] = await Promise.all([
          api.get('/v1/consumption/overview'),
          api.get(`/v1/consumption/trends?days=${trendDays}`),
        ]);
        setOverview(overviewRes.data);
        setTrends(trendsRes.data);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || '加载失败');
      console.error('Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="space-y-0 pb-2">
                <div className="h-4 bg-muted rounded animate-pulse w-24"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-muted rounded animate-pulse w-32 mb-2"></div>
                <div className="h-3 bg-muted rounded animate-pulse w-20"></div>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <div className="h-6 bg-muted rounded animate-pulse w-32"></div>
          </CardHeader>
          <CardContent>
            <div className="h-64 bg-muted rounded animate-pulse"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <TriangleAlert className="mb-4 size-8 text-destructive" />
            <h3 className="text-lg font-normal mb-2">加载失败</h3>
            <p className="text-sm text-muted-foreground mb-4">{error}</p>
            <Button onClick={fetchData}>重试</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* 管理员模式提示 */}
      {isAdmin && (
        <Card className="border-border bg-primary">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Info className="size-5 shrink-0 text-primary-foreground" />
              <div>
                <p className="font-normal text-primary">管理员模式</p>
                <p className="text-sm text-primary mt-1">
                  您当前以管理员身份登录。个人消费看板暂不支持管理员模式。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 概览卡片 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* 今日消费 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-normal">今日消费</CardTitle>
            <CircleDollarSign className="size-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-normal">
              ¥{overview?.todayCny || '0.00'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {overview?.dailyLimit
                ? `日限额: ¥${overview.dailyLimit}`
                : '无限额'}
            </p>
          </CardContent>
        </Card>

        {/* 本月消费 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-normal">本月消费</CardTitle>
            <ChartNoAxesCombined className="size-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-normal">
              ¥{overview?.monthCny || '0.00'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {overview?.monthlyLimit
                ? `月限额: ¥${overview.monthlyLimit}`
                : '无限额'}
            </p>
          </CardContent>
        </Card>

        {/* 预警状态 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-normal">预警状态</CardTitle>
            {overview?.alerts?.daily?.triggered || overview?.alerts?.monthly?.triggered
              ? <TriangleAlert className="size-5 text-destructive" />
              : <CircleCheck className="size-5 text-muted-foreground" />}
          </CardHeader>
          <CardContent>
            {overview?.alerts?.daily?.triggered ||
            overview?.alerts?.monthly?.triggered ? (
              <div>
                <div className="text-2xl font-normal text-destructive">警告</div>
                <div className="text-xs text-destructive mt-1 space-y-1">
                  {overview?.alerts?.daily?.triggered && (
                    <p>• 日消费已达阈值</p>
                  )}
                  {overview?.alerts?.monthly?.triggered && (
                    <p>• 月消费已达阈值</p>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-2xl font-normal text-foreground">正常</div>
                <p className="text-xs text-muted-foreground mt-1">消费在预算范围内</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 趋势图 */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
            <div>
              <CardTitle>消费趋势</CardTitle>
              <CardDescription className="mt-1">
                查看最近 {trendDays} 天的消费趋势
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant={trendDays === 7 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTrendDays(7)}
              >
                7天
              </Button>
              <Button
                variant={trendDays === 30 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTrendDays(30)}
              >
                30天
              </Button>
              <Button
                variant={trendDays === 90 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTrendDays(90)}
              >
                90天
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {trends && trends.trends.length > 0 && trends.summary ? (
            <div className="space-y-4">
              <TrendChart data={trends.trends} />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                <div>
                  <p className="text-xs text-muted-foreground">总消费</p>
                  <p className="text-lg font-normal">¥{trends.summary.totalCny}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">日均消费</p>
                  <p className="text-lg font-normal">¥{trends.summary.avgDailyCny}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">峰值</p>
                  <p className="text-lg font-normal">¥{trends.summary.peakDayCny}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">峰值日期</p>
                  <p className="text-lg font-normal">{trends.summary.peakDayKey}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
              <TrendingUp className="mb-2 size-8" />
              <p>暂无数据</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
