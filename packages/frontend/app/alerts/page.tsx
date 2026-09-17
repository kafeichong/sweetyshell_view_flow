'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { AlertsConfig } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AlertsPage() {
  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 表单状态
  const [formData, setFormData] = useState({
    dailyEnabled: false,
    dailyThreshold: '',
    monthlyEnabled: false,
    monthlyThreshold: '',
  });

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get('/v1/consumption/alerts');
      const data = response.data;

      setConfig(data);
      setFormData({
        dailyEnabled: data.daily?.enabled || false,
        dailyThreshold: data.daily?.thresholdCny || '',
        monthlyEnabled: data.monthly?.enabled || false,
        monthlyThreshold: data.monthly?.thresholdCny || '',
      });
    } catch (err: any) {
      setError(err.response?.data?.message || '加载失败');
      console.error('Failed to fetch alerts config:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await api.post('/v1/consumption/alerts', {
        daily: formData.dailyEnabled
          ? {
              enabled: true,
              thresholdCny: formData.dailyThreshold,
            }
          : { enabled: false },
        monthly: formData.monthlyEnabled
          ? {
              enabled: true,
              thresholdCny: formData.monthlyThreshold,
            }
          : { enabled: false },
      });

      alert('保存成功');
      fetchConfig();
    } catch (err: any) {
      alert(err.response?.data?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">预警管理</h1>
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
        <h1 className="text-2xl font-bold text-gray-900 mb-6">预警管理</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="text-red-600">
              <p className="font-medium">加载失败</p>
              <p className="text-sm mt-1">{error}</p>
              <button
                onClick={fetchConfig}
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
        <h1 className="text-2xl font-bold text-gray-900">预警管理</h1>
        <button
          onClick={fetchConfig}
          className="text-sm text-gray-600 hover:text-gray-900 self-start sm:self-auto"
        >
          🔄 刷新
        </button>
      </div>

      {/* 预警配置 */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>预警配置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* 日消费预警 */}
            <div className="border rounded-lg p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-medium text-gray-900">日消费预警</h3>
                  <p className="text-sm text-gray-500">当日消费超过设定阈值时触发预警</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.dailyEnabled}
                    onChange={(e) =>
                      setFormData({ ...formData, dailyEnabled: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {formData.dailyEnabled && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    阈值金额 (CNY)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.dailyThreshold}
                    onChange={(e) =>
                      setFormData({ ...formData, dailyThreshold: e.target.value })
                    }
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              )}
            </div>

            {/* 月消费预警 */}
            <div className="border rounded-lg p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-medium text-gray-900">月消费预警</h3>
                  <p className="text-sm text-gray-500">当月消费超过设定阈值时触发预警</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.monthlyEnabled}
                    onChange={(e) =>
                      setFormData({ ...formData, monthlyEnabled: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {formData.monthlyEnabled && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    阈值金额 (CNY)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.monthlyThreshold}
                    onChange={(e) =>
                      setFormData({ ...formData, monthlyThreshold: e.target.value })
                    }
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-6 w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        </CardContent>
      </Card>

      {/* 当前状态 */}
      <Card>
        <CardHeader>
          <CardTitle>当前预警状态</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-700">日消费预警</span>
              <span
                className={`px-3 py-1 rounded text-sm font-medium ${
                  config?.daily?.enabled
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {config?.daily?.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            {config?.daily?.enabled && (
              <div className="pl-4 text-sm text-gray-600">
                阈值: ¥{config.daily.thresholdCny}
              </div>
            )}

            <div className="flex items-center justify-between py-2">
              <span className="text-gray-700">月消费预警</span>
              <span
                className={`px-3 py-1 rounded text-sm font-medium ${
                  config?.monthly?.enabled
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {config?.monthly?.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            {config?.monthly?.enabled && (
              <div className="pl-4 text-sm text-gray-600">
                阈值: ¥{config.monthly.thresholdCny}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
