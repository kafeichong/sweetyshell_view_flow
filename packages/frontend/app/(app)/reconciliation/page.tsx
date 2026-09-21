'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { ReconciliationRecord } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

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
        <h1 className="text-2xl font-normal text-foreground mb-6">对账管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-muted-foreground py-8">
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
        <h1 className="text-2xl font-normal text-foreground mb-6">对账管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="h-64 bg-muted rounded animate-pulse"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-normal text-foreground mb-6">对账管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-destructive">
              <p className="font-normal">加载失败</p>
              <p className="text-sm mt-1">{error}</p>
              <Button
                onClick={fetchRecords}
                className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary"
              >
                重试
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <h1 className="text-2xl font-normal text-foreground">对账管理</h1>
        <Button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary self-start sm:self-auto"
        >
          {showForm ? '取消' : '+ 新建对账'}
        </Button>
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
                  <label className="block text-sm font-normal text-foreground mb-2">
                    月份 (YYYY-MM) *
                  </label>
                  <Input
                    type="text"
                    placeholder="2026-09"
                    value={formData.monthKey}
                    onChange={(e) => setFormData({ ...formData, monthKey: e.target.value })}
                    className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-normal text-foreground mb-2">
                    用户ID (可选，留空为全局对账)
                  </label>
                  <Input
                    type="text"
                    placeholder="留空表示全局对账"
                    value={formData.actorId}
                    onChange={(e) => setFormData({ ...formData, actorId: e.target.value })}
                    className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-normal text-foreground mb-2">
                  第三方平台金额 (CNY) *
                </label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.providerBillCny}
                  onChange={(e) => setFormData({ ...formData, providerBillCny: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-normal text-foreground mb-2">
                  备注 (可选)
                </label>
                <textarea
                  placeholder="对账说明..."
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                  rows={3}
                />
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary disabled:bg-muted"
              >
                {submitting ? '提交中...' : '提交对账'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 对账记录列表 */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <CardTitle>对账历史</CardTitle>
            <div className="text-sm text-muted-foreground">
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
              <Input
                type="text"
                placeholder="搜索月份..."
                value={searchMonth}
                onChange={(e) => setSearchMonth(e.target.value)}
                className="px-3 py-2 border border-border rounded-md text-sm focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              <Input
                type="text"
                placeholder="搜索用户..."
                value={searchUser}
                onChange={(e) => setSearchUser(e.target.value)}
                className="px-3 py-2 border border-border rounded-md text-sm focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              <Select
                value={filterVariance}
                onChange={(e) => setFilterVariance(e.target.value as 'all' | 'high' | 'low')}
                className="px-3 py-2 border border-border rounded-md text-sm focus:ring-2 focus:ring-ring focus:border-transparent"
              >
                <option value="all">全部差异</option>
                <option value="high">高差异 (&gt;5%)</option>
                <option value="low">低差异 (≤5%)</option>
              </Select>
            </div>
            {(searchMonth || searchUser || filterVariance !== 'all') && (
              <Button
                onClick={() => {
                  setSearchMonth('');
                  setSearchUser('');
                  setFilterVariance('all');
                }}
                className="text-sm text-primary hover:text-primary"
              >
                清除筛选
              </Button>
            )}
          </div>

          {records.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-4 font-normal text-muted-foreground">月份</th>
                    <th className="text-left py-3 px-4 font-normal text-muted-foreground">用户</th>
                    <th className="text-right py-3 px-4 font-normal text-muted-foreground">系统消费</th>
                    <th className="text-right py-3 px-4 font-normal text-muted-foreground">平台账单</th>
                    <th className="text-right py-3 px-4 font-normal text-muted-foreground">差异</th>
                    <th className="text-right py-3 px-4 font-normal text-muted-foreground">差异率</th>
                    <th className="text-left py-3 px-4 font-normal text-muted-foreground">对账时间</th>
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
                      <tr key={record.id} className="border-b hover:bg-muted">
                        <td className="py-3 px-4 font-normal">{record.monthKey}</td>
                        <td className="py-3 px-4">
                          {record.actorName || <span className="text-muted-foreground">全局</span>}
                        </td>
                        <td className="py-3 px-4 text-right">¥{record.systemTotalCny}</td>
                        <td className="py-3 px-4 text-right">¥{record.providerBillCny}</td>
                        <td className={`py-3 px-4 text-right font-normal ${
                          isHighVariance ? 'text-destructive' : 'text-foreground'
                        }`}>
                          ¥{record.varianceCny}
                        </td>
                        <td className={`py-3 px-4 text-right ${
                          isHighVariance ? 'text-destructive font-normal' : 'text-muted-foreground'
                        }`}>
                          {record.variancePercent}%
                        </td>
                        <td className="py-3 px-4 text-xs text-muted-foreground">
                          {new Date(record.reconciledAt).toLocaleDateString('zh-CN')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-8">暂无对账记录</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
