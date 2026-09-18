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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    // 检查登录状态
    const token = localStorage.getItem('auth_token');
    const mode = localStorage.getItem('auth_mode') as 'user' | 'admin' | null;

    if (!token || !mode) {
      router.push('/login');
      return;
    }

    setAuthMode(mode);
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
    ...(authMode === 'user'
      ? [
          { href: '/history', label: '任务历史', icon: '📜' },
          { href: '/alerts', label: '预警管理', icon: '⚠️' },
        ]
      : []),
    ...(authMode === 'admin'
      ? [
          { href: '/reconciliation', label: '对账管理', icon: '💰' },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Navigation */}
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              {/* Mobile menu button */}
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden mr-2 p-2 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              <h1 className="text-xl font-bold text-gray-900">
                <span className="hidden sm:inline">Video Flow Console</span>
                <span className="sm:hidden">VF Console</span>
              </h1>
              {authMode === 'admin' && (
                <span className="ml-3 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
                  管理员
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <span className="text-sm text-gray-600 hidden sm:inline">{userName}</span>
              <button
                onClick={handleLogout}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                退出
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="flex max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        {/* Sidebar - Desktop */}
        <aside className="hidden lg:block w-64 mr-8">
          <nav className="space-y-1 sticky top-20">
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

        {/* Mobile Sidebar Overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <aside
              className="fixed left-0 top-16 bottom-0 w-64 bg-white shadow-xl z-50"
              onClick={(e) => e.stopPropagation()}
            >
              <nav className="space-y-1 p-4">
                {navItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setSidebarOpen(false)}
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
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
