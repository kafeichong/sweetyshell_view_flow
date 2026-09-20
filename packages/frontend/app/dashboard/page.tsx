'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { ConsumptionOverview, ConsumptionTrendsResponse } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import TrendChart from '@/components/charts/TrendChart';

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
        // TODO: 实现管理员看板（汇总所有用户数据）
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">消费看板</h1>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <div className="h-5 bg-gray-200 rounded animate-pulse w-24"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-gray-200 rounded animate-pulse w-32"></div>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="h-64 bg-gray-200 rounded animate-pulse"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">消费看板</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-red-600">
              <p className="font-medium">加载失败</p>
              <p className="text-sm mt-1">{error}</p>
              <button
                onClick={fetchData}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                重试
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">消费看板</h1>
        <button
          onClick={fetchData}
          className="text-sm text-gray-600 hover:text-gray-900 self-start sm:self-auto"
        >
          🔄 刷新
        </button>
      </div>

      {/* 管理员模式提示 */}
      {isAdmin && (
        <Card className="mb-6 border-blue-200 bg-blue-50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <div className="text-2xl">ℹ️</div>
              <div>
                <p className="font-medium text-blue-900">管理员模式</p>
                <p className="text-sm text-blue-700 mt-1">
                  您当前以管理员身份登录。个人消费看板暂不支持管理员模式。
                  <br />
                  请访问：
                  <a href="/tokens" className="underline ml-1">Token管理</a> ·
                  <a href="/reconciliation" className="underline ml-1">对账管理</a> ·
                  <a href="/alerts" className="underline ml-1">预警配置</a>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 概览卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 mb-8">
        {/* 今日消费 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              今日消费
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-gray-900">
              ¥{overview?.todayCny || '0.00'}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {overview?.dailyLimit
                ? `日限额: ¥${overview.dailyLimit}`
                : '无限额'}
            </p>
          </CardContent>
        </Card>

        {/* 本月消费 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              本月消费
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-gray-900">
              ¥{overview?.monthCny || '0.00'}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {overview?.monthlyLimit
                ? `月限额: ¥${overview.monthlyLimit}`
                : '无限额'}
            </p>
          </CardContent>
        </Card>

        {/* 预警状态 */}
        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              预警状态
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview?.alerts?.daily?.triggered ||
            overview?.alerts?.monthly?.triggered ? (
              <div>
                <div className="text-2xl sm:text-3xl font-bold text-red-600">⚠️ 警告</div>
                <div className="text-xs text-red-600 mt-2">
                  {overview?.alerts?.daily?.triggered && (
                    <p>日消费已达阈值</p>
                  )}
                  {overview?.alerts?.monthly?.triggered && (
                    <p>月消费已达阈值</p>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-2xl sm:text-3xl font-bold text-green-600">✅ 正常</div>
                <p className="text-xs text-gray-500 mt-2">消费在预算范围内</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 趋势图 */}
      <Card className="mb-8">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <CardTitle>消费趋势</CardTitle>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setTrendDays(7)}
                className={`px-3 py-1 text-sm rounded ${
                  trendDays === 7
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                7天
              </button>
              <button
                onClick={() => setTrendDays(30)}
                className={`px-3 py-1 text-sm rounded ${
                  trendDays === 30
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                30天
              </button>
              <button
                onClick={() => setTrendDays(90)}
                className={`px-3 py-1 text-sm rounded ${
                  trendDays === 90
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                90天
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {trends && trends.trends.length > 0 && trends.summary ? (
            <div>
              <TrendChart data={trends.trends} />
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">总消费</p>
                  <p className="font-semibold text-sm sm:text-base">¥{trends.summary.totalCny}</p>
                </div>
                <div>
                  <p className="text-gray-500">日均消费</p>
                  <p className="font-semibold text-sm sm:text-base">¥{trends.summary.avgDailyCny}</p>
                </div>
                <div>
                  <p className="text-gray-500">峰值</p>
                  <p className="font-semibold text-sm sm:text-base">¥{trends.summary.peakDayCny}</p>
                </div>
                <div>
                  <p className="text-gray-500">峰值日期</p>
                  <p className="font-semibold text-sm sm:text-base">{trends.summary.peakDayKey}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-400">
              暂无数据
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
