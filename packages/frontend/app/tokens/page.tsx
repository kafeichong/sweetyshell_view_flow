'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { TokenInfo, TokenLogsResponse } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function TokensPage() {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [logs, setLogs] = useState<TokenLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [allTokens, setAllTokens] = useState<any[]>([]);
  const [selectedActorId, setSelectedActorId] = useState<string>('');

  // 过滤和搜索状态
  const [searchEndpoint, setSearchEndpoint] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  useEffect(() => {
    const mode = localStorage.getItem('auth_mode');
    setIsAdmin(mode === 'admin');
    fetchData();
  }, []);

  useEffect(() => {
    if (selectedActorId) {
      fetchActorLogs(selectedActorId);
    }
  }, [selectedActorId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const mode = localStorage.getItem('auth_mode');

      if (mode === 'admin') {
        // 管理员模式：获取所有token列表
        const tokensRes = await api.get('/v1/admin/tokens');
        setAllTokens(tokensRes.data);

        // 默认选择第一个用户
        if (tokensRes.data.length > 0) {
          setSelectedActorId(tokensRes.data[0].actorId);
        }
      } else {
        // 用户模式：获取自己的token信息和日志
        const [infoRes, logsRes] = await Promise.all([
          api.get('/v1/tokens/current'),
          api.get('/v1/tokens/usage-logs?limit=50'),
        ]);
        setInfo(infoRes.data);
        setLogs(logsRes.data);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || '加载失败');
      console.error('Failed to fetch token data:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchActorLogs = async (actorId: string) => {
    try {
      const logsRes = await api.get(`/v1/admin/tokens/${actorId}/usage-logs?limit=50`);
      setLogs(logsRes.data);
    } catch (err: any) {
      console.error('Failed to fetch actor logs:', err);
    }
  };

  // 过滤日志
  const filteredLogs = logs?.logs.filter((log) => {
    if (searchEndpoint && !log.endpoint.toLowerCase().includes(searchEndpoint.toLowerCase())) {
      return false;
    }
    if (filterMethod && log.method !== filterMethod) {
      return false;
    }
    if (filterStatus) {
      const statusRange = filterStatus;
      const status = log.statusCode;
      if (statusRange === '2xx' && (status < 200 || status >= 300)) return false;
      if (statusRange === '4xx' && (status < 400 || status >= 500)) return false;
      if (statusRange === '5xx' && (status < 500 || status >= 600)) return false;
    }
    return true;
  }) || [];

  // 导出CSV
  const exportToCSV = () => {
    if (!filteredLogs.length) {
      alert('没有数据可导出');
      return;
    }

    const headers = ['时间', '接口', '方法', '状态码', 'IP地址'];
    const rows = filteredLogs.map((log) => [
      new Date(log.createdAt).toLocaleString('zh-CN'),
      log.endpoint,
      log.method,
      log.statusCode.toString(),
      log.ipAddress || '-',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `token-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Token管理</h1>
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
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Token管理</h1>
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
        <h1 className="text-2xl font-bold text-gray-900">Token管理</h1>
        <button
          onClick={fetchData}
          className="text-sm text-gray-600 hover:text-gray-900 self-start sm:self-auto"
        >
          🔄 刷新
        </button>
      </div>

      {/* 管理员模式：用户Token列表 */}
      {isAdmin && allTokens.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
              <CardTitle>用户Token列表</CardTitle>
              <div className="text-sm text-gray-600">
                共 {allTokens.length} 个用户
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* 搜索过滤 */}
            <div className="mb-4 flex gap-2">
              <input
                type="text"
                placeholder="搜索用户名或ActorId..."
                value={searchEndpoint}
                onChange={(e) => setSearchEndpoint(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* 用户表格 */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      用户信息
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      ActorId
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      状态
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      限额
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      最后使用
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {allTokens
                    .filter((token) => {
                      if (!searchEndpoint) return true;
                      return (
                        token.name.toLowerCase().includes(searchEndpoint.toLowerCase()) ||
                        token.actorId.toLowerCase().includes(searchEndpoint.toLowerCase())
                      );
                    })
                    .map((token) => (
                      <tr key={token.actorId} className="hover:bg-gray-50">
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="font-medium text-gray-900">{token.name}</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="text-sm text-gray-900 font-mono break-all">
                            {token.actorId}
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-1 text-xs font-medium rounded-full ${
                              token.status === 'active'
                                ? 'bg-green-100 text-green-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {token.status === 'active' ? '活跃' : '停用'}
                          </span>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-600">
                          <div>日: ¥{token.dailyLimitCny || '无限制'}</div>
                          <div>月: ¥{token.monthlyLimitCny || '无限制'}</div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-600">
                          {token.lastUsedAt
                            ? new Date(token.lastUsedAt).toLocaleString('zh-CN')
                            : '从未使用'}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm">
                          <button
                            onClick={() => {
                              setSelectedActorId(token.actorId);
                              // 滚动到使用记录区域
                              document.getElementById('usage-logs')?.scrollIntoView({ behavior: 'smooth' });
                            }}
                            className="text-blue-600 hover:text-blue-900"
                          >
                            查看日志
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 管理员模式：选中用户的使用记录 */}
      {isAdmin && selectedActorId && logs && (
        <Card id="usage-logs" className="mb-6">
          <CardHeader>
            <CardTitle>
              使用记录 - {allTokens.find(t => t.actorId === selectedActorId)?.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              最近 {logs.logs.length} 条使用记录
            </p>
          </CardContent>
        </Card>
      )}

      {/* Token统计卡片 - 仅用户模式显示 */}
      {!isAdmin && info && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 mb-8">
          <Card>
            <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              总请求数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-gray-900">
              {info?.totalRequests?.toLocaleString() || 0}
            </div>
            <p className="text-xs text-gray-500 mt-2">累计API调用次数</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              最近24小时
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-gray-900">
              {info?.last24hRequests?.toLocaleString() || 0}
            </div>
            <p className="text-xs text-gray-500 mt-2">过去一天的请求数</p>
          </CardContent>
        </Card>

        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-600">
              最近7天
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-gray-900">
              {info?.last7dRequests?.toLocaleString() || 0}
            </div>
            <p className="text-xs text-gray-500 mt-2">过去一周的请求数</p>
          </CardContent>
        </Card>
      </div>
      )}

      {/* 最常用接口 - 仅用户模式显示 */}
      {!isAdmin && info?.mostUsedEndpoint && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>使用统计</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              <p className="text-gray-600 mb-2">最常用接口:</p>
              <p className="font-mono text-blue-600 text-xs sm:text-sm break-all">{info.mostUsedEndpoint}</p>
            </div>
            {info.lastUsedAt && (
              <div className="text-sm mt-4">
                <p className="text-gray-600 mb-2">最后使用时间:</p>
                <p className="font-mono text-xs sm:text-sm">{new Date(info.lastUsedAt).toLocaleString('zh-CN')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Token使用记录 */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <CardTitle>使用记录</CardTitle>
            <button
              onClick={exportToCSV}
              className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 self-start sm:self-auto"
            >
              📥 导出CSV
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {/* 搜索和过滤 */}
          <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="搜索接口..."
              value={searchEndpoint}
              onChange={(e) => setSearchEndpoint(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <select
              value={filterMethod}
              onChange={(e) => setFilterMethod(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">所有方法</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">所有状态</option>
              <option value="2xx">2xx 成功</option>
              <option value="4xx">4xx 客户端错误</option>
              <option value="5xx">5xx 服务器错误</option>
            </select>
          </div>

          {filteredLogs.length > 0 ? (
            <div className="overflow-x-auto -mx-6 sm:mx-0">
              <div className="inline-block min-w-full align-middle">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-medium text-gray-600 whitespace-nowrap">时间</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-600 whitespace-nowrap">接口</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-600 whitespace-nowrap">方法</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-600 whitespace-nowrap">状态码</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-600 whitespace-nowrap hidden md:table-cell">IP地址</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((log) => (
                      <tr key={log.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4 whitespace-nowrap text-xs sm:text-sm">
                          {new Date(log.createdAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs max-w-xs truncate">{log.endpoint}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                              log.method === 'GET'
                                ? 'bg-blue-100 text-blue-700'
                                : log.method === 'POST'
                                ? 'bg-green-100 text-green-700'
                                : log.method === 'PUT' || log.method === 'PATCH'
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {log.method}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                              log.statusCode >= 200 && log.statusCode < 300
                                ? 'bg-green-100 text-green-700'
                                : log.statusCode >= 400 && log.statusCode < 500
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {log.statusCode}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-gray-600 hidden md:table-cell">
                          {log.ipAddress || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="text-center text-gray-400 py-8">
              {searchEndpoint || filterMethod || filterStatus ? '没有匹配的记录' : '暂无使用记录'}
            </div>
          )}

          {/* 显示过滤结果统计 */}
          {(searchEndpoint || filterMethod || filterStatus) && (
            <div className="mt-4 text-sm text-gray-600">
              显示 {filteredLogs.length} / {logs?.logs.length || 0} 条记录
              <button
                onClick={() => {
                  setSearchEndpoint('');
                  setFilterMethod('');
                  setFilterStatus('');
                }}
                className="ml-4 text-blue-600 hover:text-blue-700"
              >
                清除过滤
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
