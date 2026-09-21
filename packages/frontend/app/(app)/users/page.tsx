'use client';

import { useEffect, useReducer, useState } from 'react';
import api from '@/lib/api';
import { writeClipboardText } from '@/lib/clipboard';
import { createInitialUserDialogState, userDialogReducer } from '@/lib/user-create-dialog';
import { isActorIdConfirmed } from '@/lib/user-delete';
import { formatMonthlySettled, normalizeUserBusinessUsage } from '@/lib/user-business-usage';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Check, CircleCheck, Copy, KeyRound, Trash2, TriangleAlert } from 'lucide-react';

interface User {
  actorId: string;
  name: string;
  status: string;
  dailyLimitCny: string | null;
  monthlyLimitCny: string | null;
  usageCount: number;
  canDelete: boolean;
  businessUsage: {
    totalTasks: number;
    monthlyTasks: number;
    successfulTasks: number;
  };
  spending: {
    monthlySettled: string;
  };
  lastUsedAt: string | null;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createDialog, dispatchCreateDialog] = useReducer(
    userDialogReducer,
    undefined,
    createInitialUserDialogState,
  );
  const [creatingUser, setCreatingUser] = useState(false);
  const [updatingActorId, setUpdatingActorId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deletingUser, setDeletingUser] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<User | null>(null);
  const [rotateConfirmation, setRotateConfirmation] = useState('');
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  const [rotationCopied, setRotationCopied] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);

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
    if (!createDialog.draft.actorId.trim() || !createDialog.draft.name.trim()) {
      alert('请填写完整信息');
      return;
    }

    try {
      setCreatingUser(true);
      const response = await api.post('/v1/admin/credentials', createDialog.draft);
      dispatchCreateDialog({ type: 'created', token: response.data.token });
      await fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || '创建失败');
    } finally {
      setCreatingUser(false);
    }
  };

  const copyCreatedToken = async () => {
    if (!createDialog.token) return false;
    try {
      await writeClipboardText(createDialog.token, navigator.clipboard);
      dispatchCreateDialog({ type: 'copied' });
      return true;
    } catch {
      alert('复制失败，请手动复制 Token');
      return false;
    }
  };

  const closeCreateDialog = () => {
    dispatchCreateDialog({ type: 'reset' });
    setShowCreateModal(false);
  };

  const copyAndCloseCreateDialog = async () => {
    if (await copyCreatedToken()) closeCreateDialog();
  };

  const closeDeleteDialog = () => {
    setDeleteTarget(null);
    setDeleteConfirmation('');
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget || !isActorIdConfirmed(deleteConfirmation, deleteTarget.actorId)) return;

    try {
      setDeletingUser(true);
      await api.delete(`/v1/admin/credentials/${deleteTarget.actorId}`, {
        data: { confirmActorId: deleteConfirmation },
      });
      closeDeleteDialog();
      await fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || '删除失败');
      await fetchUsers();
    } finally {
      setDeletingUser(false);
    }
  };

  const displayUsers = users.map((user) => ({
    ...user,
    businessUsage: normalizeUserBusinessUsage(user),
    spending: {
      ...user.spending,
      monthlySettled: formatMonthlySettled(user.spending?.monthlySettled),
    },
  }));

  const closeRotateDialog = () => {
    setRotateTarget(null);
    setRotateConfirmation('');
    setRotatedToken(null);
    setRotationCopied(false);
  };

  const handleRotateToken = async () => {
    if (!rotateTarget || !isActorIdConfirmed(rotateConfirmation, rotateTarget.actorId)) return;

    try {
      setRotatingToken(true);
      const response = await api.post(
        `/v1/admin/credentials/${rotateTarget.actorId}/rotate-token`,
        { confirmActorId: rotateConfirmation },
      );
      setRotatedToken(response.data.token);
      setRotateConfirmation('');
      await fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || '轮换失败');
    } finally {
      setRotatingToken(false);
    }
  };

  const copyRotatedToken = async () => {
    if (!rotatedToken) return false;
    try {
      await writeClipboardText(rotatedToken, navigator.clipboard);
      setRotationCopied(true);
      return true;
    } catch {
      alert('复制失败，请手动复制 Token');
      return false;
    }
  };

  const copyAndCloseRotateDialog = async () => {
    if (await copyRotatedToken()) closeRotateDialog();
  };

  const handleAccessChange = async (actorId: string, enabled: boolean) => {
    try {
      setUpdatingActorId(actorId);
      await api.patch(`/v1/admin/credentials/${actorId}/${enabled ? 'activate' : 'revoke'}`);
      await fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.message || `${enabled ? '启用' : '停用'}失败`);
    } finally {
      setUpdatingActorId(null);
    }
  };

  if (loading) {
    return (
      <div className="w-full">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-border"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-normal text-foreground">
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
          {displayUsers.map((user) => (
            <Card key={user.actorId} className="bg-card transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="text-lg">{user.name}</CardTitle>
                  <Badge variant="secondary" className="bg-secondary text-foreground">
                    {user.status === 'active' ? '已启用' : '已停用'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-1">{user.actorId}</p>
              </CardHeader>
              <div className="px-6 pb-6">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">累计生成任务</p>
                    <p className="mt-1 text-foreground">{user.businessUsage.totalTasks}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">本月生成任务</p>
                    <p className="mt-1 text-foreground">{user.businessUsage.monthlyTasks}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">成功任务</p>
                    <p className="mt-1 text-foreground">{user.businessUsage.successfulTasks}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">本月实际花费</p>
                    <p className="mt-1 text-foreground">
                      ¥{user.spending.monthlySettled}
                    </p>
                  </div>
                  <div className="col-span-2 flex justify-between border-t border-border pt-3 text-xs">
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

                <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                  <div>
                    <p className="text-sm text-foreground">访问权限</p>
                    <p className="text-xs text-muted-foreground">
                      {user.status === 'active' ? '当前 Token 可以访问' : '当前 Token 已暂停访问'}
                    </p>
                  </div>
                  <Switch
                    checked={user.status === 'active'}
                    disabled={updatingActorId === user.actorId}
                    onCheckedChange={(checked) => handleAccessChange(user.actorId, checked)}
                    aria-label={`${user.status === 'active' ? '停用' : '启用'} ${user.name} 的访问权限`}
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRotateTarget(user)}
                    className="flex-1"
                  >
                    <KeyRound className="size-4" />
                    轮换 Token
                  </Button>
                  {user.canDelete && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteTarget(user)}
                      className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      删除用户
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Create User Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-foreground bg-opacity-50 flex items-center justify-center z-50">
            <Card className="w-full max-w-md bg-card">
              <CardHeader>
                <CardTitle>
                  {createDialog.phase === 'form' ? '创建新用户' : '用户创建成功'}
                </CardTitle>
              </CardHeader>
              <div className="px-6 pb-6">
                <div className="space-y-4">
                  {createDialog.phase === 'form' ? (
                    <>
                      <div>
                        <label className="block text-sm font-normal text-foreground mb-1">
                          Actor ID
                        </label>
                        <Input
                          type="text"
                          value={createDialog.draft.actorId}
                          onChange={(event) => dispatchCreateDialog({
                            type: 'updateDraft',
                            field: 'actorId',
                            value: event.target.value,
                          })}
                          placeholder="例如: user-001"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-normal text-foreground mb-1">
                          用户名称
                        </label>
                        <Input
                          type="text"
                          value={createDialog.draft.name}
                          onChange={(event) => dispatchCreateDialog({
                            type: 'updateDraft',
                            field: 'name',
                            value: event.target.value,
                          })}
                          placeholder="例如: 张三"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleCreateUser}
                          disabled={creatingUser}
                          className="flex-1"
                        >
                          {creatingUser ? '创建中…' : '创建用户'}
                        </Button>
                        <Button variant="outline" onClick={closeCreateDialog} className="flex-1">
                          取消
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-md border border-border bg-secondary/50 p-4">
                        <p className="mb-3 flex items-center gap-2 text-sm text-foreground">
                          <CircleCheck className="size-4" />请立即复制并妥善保存 Token
                        </p>
                        <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-card">
                          <code className="min-w-0 flex-1 break-all p-3 text-sm text-foreground">
                            {createDialog.token}
                          </code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={copyCreatedToken}
                            className="h-auto shrink-0 rounded-none border-l border-border"
                            aria-label="复制新用户 Token"
                          >
                            {createDialog.copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                          </Button>
                        </div>
                        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                          <TriangleAlert className="size-4" />Token 关闭后不再显示
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={copyAndCloseCreateDialog} className="flex-1">
                          {createDialog.copied ? '已复制，关闭' : '复制并关闭'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => dispatchCreateDialog({ type: 'reset' })}
                          className="flex-1"
                        >
                          继续创建
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}

        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50">
            <Card className="w-full max-w-md bg-card">
              <CardHeader>
                <CardTitle>永久删除用户</CardTitle>
              </CardHeader>
              <div className="space-y-4 px-6 pb-6">
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                  <p className="text-foreground">
                    删除后该用户的 Token 将立即永久失效，此操作无法撤销。
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    请输入 Actor ID <code className="text-foreground">{deleteTarget.actorId}</code> 确认。
                  </p>
                </div>
                <Input
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  placeholder={deleteTarget.actorId}
                  aria-label="输入 Actor ID 确认删除"
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={handleDeleteUser}
                    disabled={
                      deletingUser ||
                      !isActorIdConfirmed(deleteConfirmation, deleteTarget.actorId)
                    }
                    className="flex-1"
                  >
                    {deletingUser ? '删除中…' : '永久删除'}
                  </Button>
                  <Button variant="outline" onClick={closeDeleteDialog} className="flex-1">
                    取消
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {rotateTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50">
            <Card className="w-full max-w-md bg-card">
              <CardHeader>
                <CardTitle>{rotatedToken ? 'Token 已轮换' : '轮换 Token'}</CardTitle>
              </CardHeader>
              <div className="space-y-4 px-6 pb-6">
                {rotatedToken ? (
                  <>
                    <div className="rounded-md border border-border bg-secondary/50 p-4">
                      <p className="mb-3 flex items-center gap-2 text-sm text-foreground">
                        <CircleCheck className="size-4" />旧 Token 已失效，请立即保存新 Token
                      </p>
                      <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-card">
                        <code className="min-w-0 flex-1 break-all p-3 text-sm text-foreground">
                          {rotatedToken}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={copyRotatedToken}
                          className="h-auto shrink-0 rounded-none border-l border-border"
                          aria-label="复制轮换后的 Token"
                        >
                          {rotationCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                        </Button>
                      </div>
                      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <TriangleAlert className="size-4" />Token 关闭后不再显示
                      </p>
                    </div>
                    <Button onClick={copyAndCloseRotateDialog} className="w-full">
                      {rotationCopied ? '已复制，关闭' : '复制并关闭'}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                      <p className="text-foreground">
                        轮换后旧 Token 会立即永久失效，用户必须改用新 Token。
                      </p>
                      <p className="mt-2 text-muted-foreground">
                        请输入 Actor ID <code className="text-foreground">{rotateTarget.actorId}</code> 确认。
                      </p>
                    </div>
                    <Input
                      value={rotateConfirmation}
                      onChange={(event) => setRotateConfirmation(event.target.value)}
                      placeholder={rotateTarget.actorId}
                      aria-label="输入 Actor ID 确认轮换 Token"
                      autoComplete="off"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        onClick={handleRotateToken}
                        disabled={
                          rotatingToken ||
                          !isActorIdConfirmed(rotateConfirmation, rotateTarget.actorId)
                        }
                        className="flex-1"
                      >
                        {rotatingToken ? '轮换中…' : '确认轮换'}
                      </Button>
                      <Button variant="outline" onClick={closeRotateDialog} className="flex-1">
                        取消
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>
        )}
    </div>
  );
}
