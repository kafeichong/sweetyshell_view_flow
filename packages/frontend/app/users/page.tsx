'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { CircleCheck, TriangleAlert } from 'lucide-react';

interface User {
  actorId: string;
  name: string;
  status: string;
  dailyLimitCny: string | null;
  monthlyLimitCny: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newUser, setNewUser] = useState({ actorId: '', name: '' });
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  useEffect(() => {
    const mode = localStorage.getItem('auth_mode');
    if (mode !== 'admin') {
      window.location.href = '/login';
      return;
    }
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await api.get('/v1/admin/tokens');
      setUsers(response.data);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async () => {
    if (!newUser.actorId.trim() || !newUser.name.trim()) {
      alert('请填写完整信息');
      return;
    }

    try {
      const response = await api.post('/v1/admin/credentials', newUser);
      setCreatedToken(response.data.token);
      setNewUser({ actorId: '', name: '' });
      fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || '创建失败');
    }
  };

  const handleRevokeUser = async (actorId: string) => {
    if (!confirm(`确定要禁用用户 ${actorId} 吗？`)) return;

    try {
      await api.patch(`/v1/admin/credentials/${actorId}/revoke`);
      fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || '禁用失败');
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-border"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen p-6">
      <div className="container mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-normal bg-clip-text text-transparent">
              用户管理
            </h1>
            <p className="text-sm text-muted-foreground mt-1">管理用户凭证和访问权限</p>
          </div>
          <Button
            onClick={() => setShowCreateModal(true)}
            className="bg-primary hover:bg-primary text-primary-foreground"
          >
            + 创建用户
          </Button>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-destructive/10 border border-destructive/50 rounded-md text-destructive">
            {error}
          </div>
        )}

        {/* Users List */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {users.map((user) => (
            <Card key={user.actorId} className="bg-card transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="text-lg">{user.name}</CardTitle>
                  <Badge
                    variant={user.status === 'active' ? 'secondary' : 'destructive'}
                    className={user.status === 'active' ? 'bg-secondary text-foreground' : undefined}
                  >
                    {user.status === 'active' ? '活跃' : '已禁用'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-1">{user.actorId}</p>
              </CardHeader>
              <div className="px-6 pb-6">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">日限额：</span>
                    <span className="font-normal">
                      {user.dailyLimitCny ? `¥${user.dailyLimitCny}` : '无限制'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">月限额：</span>
                    <span className="font-normal">
                      {user.monthlyLimitCny ? `¥${user.monthlyLimitCny}` : '无限制'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">使用次数：</span>
                    <span className="font-normal">{user.usageCount}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">最后使用：</span>
                    <span className="text-muted-foreground">
                      {user.lastUsedAt
                        ? new Date(user.lastUsedAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '从未使用'}
                    </span>
                  </div>
                </div>

                {user.status === 'active' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRevokeUser(user.actorId)}
                    className="w-full mt-4 text-destructive hover:bg-destructive/10"
                  >
                    禁用用户
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>

        {/* Create User Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-foreground bg-opacity-50 flex items-center justify-center z-50">
            <Card className="w-full max-w-md bg-card">
              <CardHeader>
                <CardTitle>创建新用户</CardTitle>
              </CardHeader>
              <div className="px-6 pb-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-normal text-foreground mb-1">
                      Actor ID
                    </label>
                    <Input
                      type="text"
                      value={newUser.actorId}
                      onChange={(e) => setNewUser({ ...newUser, actorId: e.target.value })}
                      className="w-full px-3 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                      placeholder="例如: user-001"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-normal text-foreground mb-1">
                      用户名称
                    </label>
                    <Input
                      type="text"
                      value={newUser.name}
                      onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                      className="w-full px-3 py-2 border border-border rounded-md focus:ring-2 focus:ring-ring focus:border-transparent"
                      placeholder="例如: 张三"
                    />
                  </div>

                  {createdToken && (
                    <div className="p-4 bg-secondary border border-border rounded-md">
                      <p className="mb-2 flex items-center gap-2 text-sm font-normal text-foreground">
                        <CircleCheck className="size-4" />用户创建成功，请保存此 Token：
                      </p>
                      <div className="bg-card p-3 rounded border border-border font-mono text-sm break-all">
                        {createdToken}
                      </div>
                      <p className="mt-2 flex items-center gap-2 text-xs text-foreground">
                        <TriangleAlert className="size-4" />Token 仅显示一次，请立即保存
                      </p>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      onClick={handleCreateUser}
                      className="flex-1 bg-primary hover:bg-primary text-primary-foreground"
                    >
                      创建
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowCreateModal(false);
                        setCreatedToken(null);
                        setNewUser({ actorId: '', name: '' });
                      }}
                      className="flex-1"
                    >
                      {createdToken ? '关闭' : '取消'}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
