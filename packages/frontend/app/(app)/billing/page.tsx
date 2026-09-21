'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TaskAllocation {
  taskId: string;
  actorId: string | null;
  durationSeconds: number;
  allocatedCny: string;
  proportionPercent: number;
}

interface ImportPreview {
  monthKey: string;
  provider: string;
  billTotal: string;
  allocations: TaskAllocation[];
  unallocatedCny: string;
  existingBillId: string | null;
  isAlreadyImported: boolean;
}

export default function BillingImportPage() {
  const [monthKey, setMonthKey] = useState('');
  const [provider, setProvider] = useState('volcengine');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setLoading(true);
      setError(null);
      setConfirmed(false);

      const response = await api.post('/v1/admin/billing/import', {
        monthKey,
        provider,
      });

      setPreview(response.data);
    } catch (err: any) {
      setError(err.response?.data?.message || '导入失败');
      console.error('Failed to import billing:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;

    try {
      setConfirming(true);
      setError(null);

      const userId = localStorage.getItem('user_id') || 'admin';

      await api.post('/v1/admin/billing/confirm', {
        monthKey: preview.monthKey,
        provider: preview.provider,
        userId,
      });

      setConfirmed(true);
      alert('账单分配已确认');
    } catch (err: any) {
      setError(err.response?.data?.message || '确认失败');
      console.error('Failed to confirm billing:', err);
    } finally {
      setConfirming(false);
    }
  };

  const authMode = typeof window !== 'undefined' ? localStorage.getItem('auth_mode') : null;
  const isAdmin = authMode === 'admin';

  if (!isAdmin) {
    return (
      <div>
        <h1 className="text-2xl font-normal text-foreground mb-6">账单导入</h1>
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

  return (
    <div>
      <h1 className="text-2xl font-normal text-foreground mb-6">账单导入与分配</h1>

      {/* 导入表单 */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>导入 Provider 账单</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleImport} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-normal text-foreground mb-2">
                  月份 (YYYY-MM) *
                </label>
                <Input
                  type="text"
                  placeholder="2026-09"
                  value={monthKey}
                  onChange={(e) => setMonthKey(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-normal text-foreground mb-2">
                  Provider *
                </label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                >
                  <option value="volcengine">火山引擎</option>
                </select>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary disabled:bg-muted"
            >
              {loading ? '导入中...' : '导入并预览'}
            </Button>
          </form>

          {error && (
            <div className="mt-4 p-4 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 预览结果 */}
      {preview && (
        <>
          <Card className="mb-8">
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle>账单概览</CardTitle>
                {preview.isAlreadyImported && (
                  <span className="text-sm text-muted-foreground">已导入</span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">月份</p>
                  <p className="text-lg font-normal">{preview.monthKey}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Provider</p>
                  <p className="text-lg font-normal">{preview.provider}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">总金额</p>
                  <p className="text-lg font-normal">¥{preview.billTotal}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">任务数</p>
                  <p className="text-lg font-normal">{preview.allocations.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-8">
            <CardHeader>
              <CardTitle>分配预览 (按执行时长比例)</CardTitle>
            </CardHeader>
            <CardContent>
              {preview.allocations.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-3 px-4 font-normal text-muted-foreground">任务ID</th>
                        <th className="text-left py-3 px-4 font-normal text-muted-foreground">用户</th>
                        <th className="text-right py-3 px-4 font-normal text-muted-foreground">执行时长(秒)</th>
                        <th className="text-right py-3 px-4 font-normal text-muted-foreground">分配金额</th>
                        <th className="text-right py-3 px-4 font-normal text-muted-foreground">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.allocations.map((allocation) => (
                        <tr key={allocation.taskId} className="border-b hover:bg-muted">
                          <td className="py-3 px-4 font-mono text-xs">{allocation.taskId.slice(0, 8)}</td>
                          <td className="py-3 px-4">
                            {allocation.actorId || <span className="text-muted-foreground">未知</span>}
                          </td>
                          <td className="py-3 px-4 text-right">{allocation.durationSeconds}</td>
                          <td className="py-3 px-4 text-right">¥{allocation.allocatedCny}</td>
                          <td className="py-3 px-4 text-right">{allocation.proportionPercent.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2">
                        <td colSpan={3} className="py-3 px-4 font-normal">未分配</td>
                        <td className="py-3 px-4 text-right font-normal">¥{preview.unallocatedCny}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-8">
                  当月无已完成任务，账单全额未分配
                </div>
              )}

              <div className="mt-6 flex justify-end">
                <Button
                  onClick={handleConfirm}
                  disabled={confirming || confirmed}
                  className="px-6 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary disabled:bg-muted"
                >
                  {confirming ? '确认中...' : confirmed ? '已确认' : '确认分配'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
