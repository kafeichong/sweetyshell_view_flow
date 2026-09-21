'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { AlertsConfig } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/page-header';
import { PageState } from '@/components/page-state';
import { StatusBadge } from '@/components/status-badge';

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
    return <PageState kind="loading" title="正在加载预警配置" />;
  }

  if (error) {
    return <PageState kind="error" title="预警配置加载失败" description={error} action={<Button onClick={() => void fetchConfig()}>重试</Button>} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="预警管理" description="配置日消费和月消费阈值。" actions={<Button variant="outline" onClick={() => void fetchConfig()}>刷新</Button>} />

      {/* 预警配置 */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>预警配置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* 日消费预警 */}
            <div className="border rounded-md p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-normal text-foreground">日消费预警</h3>
                  <p className="text-sm text-muted-foreground">当日消费超过设定阈值时触发预警</p>
                </div>
                <Switch checked={formData.dailyEnabled} onCheckedChange={(checked) => setFormData({ ...formData, dailyEnabled: checked })} aria-label="启用日消费预警" />
              </div>

              {formData.dailyEnabled && (
                <div>
                  <label className="block text-sm font-normal text-foreground mb-2">
                    阈值金额 (CNY)
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.dailyThreshold}
                    onChange={(e) =>
                      setFormData({ ...formData, dailyThreshold: e.target.value })
                    }
                  />
                </div>
              )}
            </div>

            {/* 月消费预警 */}
            <div className="border rounded-md p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-normal text-foreground">月消费预警</h3>
                  <p className="text-sm text-muted-foreground">当月消费超过设定阈值时触发预警</p>
                </div>
                <Switch checked={formData.monthlyEnabled} onCheckedChange={(checked) => setFormData({ ...formData, monthlyEnabled: checked })} aria-label="启用月消费预警" />
              </div>

              {formData.monthlyEnabled && (
                <div>
                  <label className="block text-sm font-normal text-foreground mb-2">
                    阈值金额 (CNY)
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.monthlyThreshold}
                    onChange={(e) =>
                      setFormData({ ...formData, monthlyThreshold: e.target.value })
                    }
                  />
                </div>
              )}
            </div>
          </div>

          <Button
            onClick={() => void handleSave()}
            disabled={saving}
            className="mt-6 w-full"
          >
            {saving ? '保存中...' : '保存配置'}
          </Button>
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
              <span className="text-foreground">日消费预警</span>
              <StatusBadge status={config?.daily?.enabled ? 'active' : 'disabled'} label={config?.daily?.enabled ? '已启用' : '已禁用'} />
            </div>
            {config?.daily?.enabled && (
              <div className="pl-4 text-sm text-muted-foreground">
                阈值: ¥{config.daily.thresholdCny}
              </div>
            )}

            <div className="flex items-center justify-between py-2">
              <span className="text-foreground">月消费预警</span>
              <StatusBadge status={config?.monthly?.enabled ? 'active' : 'disabled'} label={config?.monthly?.enabled ? '已启用' : '已禁用'} />
            </div>
            {config?.monthly?.enabled && (
              <div className="pl-4 text-sm text-muted-foreground">
                阈值: ¥{config.monthly.thresholdCny}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
