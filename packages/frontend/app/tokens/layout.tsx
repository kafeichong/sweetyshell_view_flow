'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [authMode, setAuthMode] = useState<'user' | 'admin' | null>(null);
  const [userName, setUserName] = useState<string>('用户');

  useEffect(() => {
    // 检查登录状态
    const token = localStorage.getItem('auth_token');
    const mode = localStorage.getItem('auth_mode') as 'user' | 'admin' | null;

    if (!token || !mode) {
      router.push('/login');
      return;
    }

    setAuthMode(mode);
    // 可以从localStorage或API获取用户名
    setUserName(mode === 'admin' ? '管理员' : '用户');
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_mode');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  if (!authMode) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  const navItems = [
    { href: '/dashboard', label: '消费看板', icon: '📊' },
    { href: '/tokens', label: 'Token管理', icon: '🔑' },
    ...(authMode === 'admin'
      ? [
          { href: '/reconciliation', label: '对账管理', icon: '💰' },
        ]
      : [
          { href: '/alerts', label: '预警管理', icon: '⚠️' },
        ]),
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Navigation */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-bold text-gray-900">
                Video Flow Console
              </h1>
              {authMode === 'admin' && (
                <span className="ml-3 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
                  管理员
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{userName}</span>
              <button
                onClick={handleLogout}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="flex max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Sidebar */}
        <aside className="w-64 mr-8">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="mr-3 text-lg">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
