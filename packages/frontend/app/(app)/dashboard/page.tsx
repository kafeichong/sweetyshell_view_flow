'use client';

import { useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import type { AdminConsumptionSummary, ConsumptionOverview, ConsumptionTrendsResponse } from '@/types/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import TrendChart from '@/components/charts/TrendChart';
import { ChartNoAxesCombined, CircleDollarSign, Clock3, ListChecks, TrendingUp, TriangleAlert } from 'lucide-react';

const money = (value?: string | null) => Number(value || 0).toFixed(2);

export default function DashboardPage() {
  const [overview, setOverview] = useState<ConsumptionOverview | null>(null);
  const [trends, setTrends] = useState<ConsumptionTrendsResponse | null>(null);
  const [adminSummary, setAdminSummary] = useState<AdminConsumptionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState(30);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const admin = localStorage.getItem('auth_mode') === 'admin';
    setIsAdmin(admin);

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        if (admin) {
          const [overviewRes, trendsRes, summaryRes] = await Promise.all([
            api.get('/v1/admin/consumption/overview'),
            api.get(`/v1/admin/consumption/trends?days=${trendDays}`),
            api.get('/v1/admin/consumption/summary'),
          ]);
          setOverview(overviewRes.data);
          setTrends(trendsRes.data);
          setAdminSummary(summaryRes.data);
        } else {
          const [overviewRes, trendsRes] = await Promise.all([
            api.get('/v1/consumption/overview'),
            api.get(`/v1/consumption/trends?days=${trendDays}`),
          ]);
          setOverview(overviewRes.data);
          setTrends(trendsRes.data);
          setAdminSummary(null);
        }
      } catch (err: any) {
        setError(err.response?.data?.message || '加载失败');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [trendDays]);

  const trendSummary = useMemo(() => {
    const points = trends?.trends || [];
    const total = points.reduce((sum, point) => sum + Number(point.amount || 0), 0);
    const peak = points.reduce(
      (current, point) => Number(point.amount) > Number(current?.amount || 0) ? point : current,
      points[0],
    );
    return {
      total,
      average: points.length ? total / points.length : 0,
      peakAmount: Number(peak?.amount || 0),
      peakDate: peak?.date || '-',
    };
  }, [trends]);

  if (loading) return <div className="h-72 animate-pulse rounded-md bg-muted" />;

  if (error || !overview) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <TriangleAlert className="mb-3 size-8 text-destructive" />
          <p className="text-base">消费数据加载失败</p>
          <p className="mt-1 text-sm text-muted-foreground">{error || '接口未返回有效数据'}</p>
        </CardContent>
      </Card>
    );
  }

  const hasAlerts = Boolean(overview.daily.alerts?.length || overview.monthly.alerts?.length);
  const cards = [
    {
      title: '今日消费（含预占）', value: overview.daily.total,
      detail: `已结算 ¥${money(overview.daily.settled)} · 预占/待复核 ¥${money(overview.daily.reserved)}`,
      icon: CircleDollarSign,
    },
    {
      title: '本月消费（含预占）', value: overview.monthly.total,
      detail: `已结算 ¥${money(overview.monthly.settled)} · 预占/待复核 ¥${money(overview.monthly.reserved)}`,
      icon: ChartNoAxesCombined,
    },
    {
      title: '本月任务', value: String(overview.monthly.taskCount),
      detail: isAdmin ? '全站已结算及处理中任务' : '个人已结算及处理中任务',
      icon: ListChecks, currency: false,
    },
    {
      title: isAdmin ? '待结算金额' : '本月剩余额度',
      value: isAdmin ? overview.monthly.reserved : overview.monthly.remaining,
      detail: isAdmin ? '预占和待复核金额，不代表最终实际花费'
        : overview.monthly.limit ? `本月限额 ¥${money(overview.monthly.limit)}` : '未设置月度限额',
      icon: Clock3,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-normal">{isAdmin ? '全站消费看板' : '消费看板'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">已结算代表实际费用，预占/待复核金额会随任务结算更新。</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-normal">{card.title}</CardTitle>
              <card.icon className="size-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-normal">{card.currency === false ? card.value : `¥${money(card.value)}`}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{card.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {!isAdmin && hasAlerts && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex gap-3 py-4 text-sm text-destructive">
            <TriangleAlert className="size-5 shrink-0" />
            <div>{[...(overview.daily.alerts || []), ...(overview.monthly.alerts || [])].map((alert) => <p key={alert.type}>{alert.message}</p>)}</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div><CardTitle className="font-normal">已结算消费趋势</CardTitle><CardDescription className="mt-1">趋势仅统计最终已结算费用</CardDescription></div>
            <div className="flex gap-2">
              {[7, 30, 90].map((days) => <Button key={days} variant={trendDays === days ? 'default' : 'outline'} size="sm" onClick={() => setTrendDays(days)}>{days}天</Button>)}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {trends?.trends.length ? (
            <div className="space-y-4">
              <TrendChart data={trends.trends} />
              <div className="grid grid-cols-2 gap-4 border-t pt-4 md:grid-cols-4">
                <Metric label="区间总消费" value={`¥${trendSummary.total.toFixed(2)}`} />
                <Metric label="有消费日均值" value={`¥${trendSummary.average.toFixed(2)}`} />
                <Metric label="单日峰值" value={`¥${trendSummary.peakAmount.toFixed(2)}`} />
                <Metric label="峰值日期" value={trendSummary.peakDate} />
              </div>
            </div>
          ) : <div className="flex h-64 flex-col items-center justify-center text-muted-foreground"><TrendingUp className="mb-2 size-8" /><p>所选区间暂无已结算消费</p></div>}
        </CardContent>
      </Card>

      {isAdmin && adminSummary && (
        <Card>
          <CardHeader><CardTitle className="font-normal">本月用户消费排行</CardTitle><CardDescription>按实际已结算金额排序；单个用户明细请前往“用户 Token”。</CardDescription></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>Actor ID</TableHead><TableHead className="text-right">任务数</TableHead><TableHead className="text-right">已结算</TableHead></TableRow></TableHeader>
              <TableBody>
                {[...adminSummary.byActor].sort((a, b) => Number(b.settled) - Number(a.settled)).map((actor) => (
                  <TableRow key={actor.actorId}><TableCell>{actor.name}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{actor.actorId}</TableCell><TableCell className="text-right">{actor.taskCount}</TableCell><TableCell className="text-right">¥{money(actor.settled)}</TableCell></TableRow>
                ))}
                {!adminSummary.byActor.length && <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">本月暂无已结算消费</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-normal">{value}</p></div>;
}
