'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'user' | 'admin'>('user');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!token.trim()) {
      setError('请输入Token');
      return;
    }

    setError('');
    setLoading(true);

    try {
      // 保存认证信息
      localStorage.setItem('auth_token', token);
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
    } catch (err: any) {
      // 清除无效的认证信息
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_mode');
      localStorage.removeItem('auth_user');

      if (err.response?.status === 401 || err.response?.status === 403) {
        setError('Token无效或已过期');
      } else if (err.code === 'ERR_NETWORK' || err.message?.includes('Network')) {
        setError('连接服务器失败，请检查API地址配置');
      } else {
        setError(err.response?.data?.message || '登录失败，请重试');
      }
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8 p-8 bg-white rounded-lg shadow-md">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            {process.env.NEXT_PUBLIC_APP_NAME || 'Video Flow Console'}
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            消费管理与数据分析平台
          </p>
        </div>

        {/* Mode Selection */}
        <div className="flex gap-4">
          <button
            onClick={() => setMode('user')}
            className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all ${
              mode === 'user'
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
            }`}
          >
            <div className="text-2xl mb-1">👤</div>
            <div className="font-medium">用户登录</div>
            <div className="text-xs mt-1 opacity-75">查看我的数据</div>
          </button>

          <button
            onClick={() => setMode('admin')}
            className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all ${
              mode === 'admin'
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
            }`}
          >
            <div className="text-2xl mb-1">🔑</div>
            <div className="font-medium">管理员登录</div>
            <div className="text-xs mt-1 opacity-75">管理系统</div>
          </button>
        </div>

        {/* Token Input */}
        <div>
          <label htmlFor="token" className="block text-sm font-medium text-gray-700 mb-2">
            {mode === 'user' ? 'Actor Token' : 'Admin Token'}
          </label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
            placeholder="请输入Token..."
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            {error}
          </div>
        )}

        {/* Login Button */}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? '登录中...' : '登录'}
        </button>

        {/* Help Text */}
        <div className="text-xs text-gray-500 text-center">
          <p>需要Token？请联系管理员获取</p>
          <p className="mt-1">API地址: {process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000'}</p>
        </div>
      </div>
    </div>
  );
}
