'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import api from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { credentialFingerprint, normalizeLoginToken } from '@/lib/auth-token';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'user' | 'admin'>('user');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const normalizedToken = normalizeLoginToken(token);
    if (!normalizedToken) {
      setError('请输入Token');
      return;
    }

    setError('');
    setLoading(true);

    try {
      // 保存认证信息
      localStorage.setItem('auth_token', normalizedToken);
      localStorage.setItem('auth_mode', mode);

      // 根据模式选择不同的验证端点
      const testEndpoint = mode === 'admin'
        ? '/v1/admin/tokens'  // 管理员使用admin端点验证
        : '/v1/consumption/overview';  // 用户使用consumption端点验证

      const response = await api.get(testEndpoint);

      if (response.status === 200) {
        // Token有效，保存用户信息并跳转
        if (mode === 'user') {
          localStorage.setItem('auth_user', JSON.stringify({ mode: 'user' }));
        } else {
          localStorage.setItem('auth_user', JSON.stringify({ mode: 'admin' }));
        }
        router.push('/dashboard');
      }
    } catch (err: unknown) {
      // 清除无效的认证信息
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_mode');
      localStorage.removeItem('auth_user');

      if (axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
        setError('Token无效或已过期');
      } else if (axios.isAxiosError(err) && (err.code === 'ERR_NETWORK' || err.message?.includes('Network'))) {
        setError('连接服务器失败，请检查API地址配置');
      } else {
        const message = axios.isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : null;
        setError(message || '登录失败，请重试');
      }
      console.error('Login rejected', {
        mode,
        credentialLength: normalizedToken.length,
        credentialFingerprint: await credentialFingerprint(normalizedToken),
        apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
        status: axios.isAxiosError(err) ? err.response?.status : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{process.env.NEXT_PUBLIC_APP_NAME || '糖果壳®SweetyShell®'}</CardTitle>
          <CardDescription>消费管理与数据分析平台</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={mode === 'user' ? 'default' : 'outline'} onClick={() => setMode('user')}>用户登录</Button>
            <Button type="button" variant={mode === 'admin' ? 'default' : 'outline'} onClick={() => setMode('admin')}>管理员登录</Button>
          </div>
          <div className="space-y-2">
            <label htmlFor="token" className="text-sm font-normal">{mode === 'user' ? 'Actor Token' : 'Admin Token'}</label>
            <Input
              id="token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleLogin(); }}
              placeholder="请输入 Token"
              disabled={loading}
            />
          </div>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <Button className="w-full" onClick={() => void handleLogin()} disabled={loading}>{loading ? '登录中…' : '登录'}</Button>
          <div className="space-y-1 text-center text-xs text-muted-foreground">
            <p>需要 Token？请联系管理员获取</p>
            <p>本地用户：creative-yuyo.token 或 creative-zhuyang.token</p>
            <p>本地管理员：local-admin.token</p>
            <p>API 地址：{process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
