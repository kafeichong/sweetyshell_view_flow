'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { ReconciliationRecord } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function ReconciliationPage() {
  const [records, setRecords] = useState<ReconciliationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // 搜索和筛选状态
  const [searchMonth, setSearchMonth] = useState('');
  const [searchUser, setSearchUser] = useState('');
  const [filterVariance, setFilterVariance] = useState<'all' | 'high' | 'low'>('all');

  // 表单状态
  const [formData, setFormData] = useState({
    monthKey: '',
    actorId: '',
    providerBillCny: '',
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchRecords();
  }, []);

  const fetchRecords = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get('/v1/admin/reconciliation/records');
      setRecords(response.data.records || []);
    } catch (err: any) {
      setError(err.response?.data?.message || '加载失败');
      console.error('Failed to fetch reconciliation records:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setSubmitting(true);
      await api.post('/v1/admin/reconciliation/submit', {
        monthKey: formData.monthKey,
        actorId: formData.actorId || undefined,
        providerBillCny: formData.providerBillCny,
        notes: formData.notes || undefined,
      });

      // 成功后重置表单并刷新列表
      setFormData({ monthKey: '', actorId: '', providerBillCny: '', notes: '' });
      setShowForm(false);
      fetchRecords();
    } catch (err: any) {
      alert(err.response?.data?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 检查是否是管理员
  const authMode = typeof window !== 'undefined' ? localStorage.getItem('auth_mode') : null;
  const isAdmin = authMode === 'admin';

  if (!isAdmin) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">对账管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-gray-500 py-8">
              <p>仅管理员可访问此功能</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">对账管理</h1>
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
        <h1 className="text-2xl font-bold text-gray-900 mb-6">对账管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-red-600">
              <p className="font-medium">加载失败</p>
              <p className="text-sm mt-1">{error}</p>
              <button
                onClick={fetchRecords}
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
        <h1 className="text-2xl font-bold text-gray-900">对账管理</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 self-start sm:self-auto"
        >
          {showForm ? '取消' : '+ 新建对账'}
        </button>
      </div>

      {/* 对账表单 */}
      {showForm && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>提交对账记录</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    月份 (YYYY-MM) *
                  </label>
                  <input
                    type="text"
                    placeholder="2026-09"
                    value={formData.monthKey}
                    onChange={(e) => setFormData({ ...formData, monthKey: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    用户ID (可选，留空为全局对账)
                  </label>
                  <input
                    type="text"
                    placeholder="留空表示全局对账"
                    value={formData.actorId}
                    onChange={(e) => setFormData({ ...formData, actorId: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  第三方平台金额 (CNY) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.providerBillCny}
                  onChange={(e) => setFormData({ ...formData, providerBillCny: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  备注 (可选)
                </label>
                <textarea
                  placeholder="对账说明..."
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  rows={3}
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
              >
                {submitting ? '提交中...' : '提交对账'}
              </button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 对账记录列表 */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <CardTitle>对账历史</CardTitle>
            <div className="text-sm text-gray-600">
              共 {records.filter((record) => {
                if (searchMonth && !record.monthKey.includes(searchMonth)) return false;
                if (searchUser && !(record.actorName?.toLowerCase().includes(searchUser.toLowerCase()))) return false;
                if (filterVariance !== 'all') {
                  const variance = Math.abs(parseFloat(record.variancePercent));
                  if (filterVariance === 'high' && variance <= 5) return false;
                  if (filterVariance === 'low' && variance > 5) return false;
                }
                return true;
              }).length} 条记录
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* 搜索和筛选 */}
          <div className="mb-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                placeholder="搜索月份..."
                value={searchMonth}
                onChange={(e) => setSearchMonth(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <input
                type="text"
                placeholder="搜索用户..."
                value={searchUser}
                onChange={(e) => setSearchUser(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <select
                value={filterVariance}
                onChange={(e) => setFilterVariance(e.target.value as 'all' | 'high' | 'low')}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">全部差异</option>
                <option value="high">高差异 (&gt;5%)</option>
                <option value="low">低差异 (≤5%)</option>
              </select>
            </div>
            {(searchMonth || searchUser || filterVariance !== 'all') && (
              <button
                onClick={() => {
                  setSearchMonth('');
                  setSearchUser('');
                  setFilterVariance('all');
                }}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                清除筛选
              </button>
            )}
          </div>

          {records.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-medium text-gray-600">月份</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-600">用户</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-600">系统消费</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-600">平台账单</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-600">差异</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-600">差异率</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-600">对账时间</th>
                  </tr>
                </thead>
                <tbody>
                  {records
                    .filter((record) => {
                      if (searchMonth && !record.monthKey.includes(searchMonth)) return false;
                      if (searchUser && !(record.actorName?.toLowerCase().includes(searchUser.toLowerCase()))) return false;
                      if (filterVariance !== 'all') {
                        const variance = Math.abs(parseFloat(record.variancePercent));
                        if (filterVariance === 'high' && variance <= 5) return false;
                        if (filterVariance === 'low' && variance > 5) return false;
                      }
                      return true;
                    })
                    .map((record) => {
                    const variancePercent = parseFloat(record.variancePercent);
                    const isHighVariance = Math.abs(variancePercent) > 5;

                    return (
                      <tr key={record.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4 font-medium">{record.monthKey}</td>
                        <td className="py-3 px-4">
                          {record.actorName || <span className="text-gray-400">全局</span>}
                        </td>
                        <td className="py-3 px-4 text-right">¥{record.systemTotalCny}</td>
                        <td className="py-3 px-4 text-right">¥{record.providerBillCny}</td>
                        <td className={`py-3 px-4 text-right font-medium ${
                          isHighVariance ? 'text-red-600' : 'text-gray-900'
                        }`}>
                          ¥{record.varianceCny}
                        </td>
                        <td className={`py-3 px-4 text-right ${
                          isHighVariance ? 'text-red-600 font-medium' : 'text-gray-600'
                        }`}>
                          {record.variancePercent}%
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-600">
                          {new Date(record.reconciledAt).toLocaleDateString('zh-CN')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center text-gray-400 py-8">暂无对账记录</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
