'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authMode, setAuthMode] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    const mode = localStorage.getItem('auth_mode');

    if (!token || !mode) {
      router.push('/login');
      return;
    }

    setAuthMode(mode);
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_mode');
    router.push('/login');
  };

  const navItems = [
    { href: '/dashboard', label: '消费看板', icon: '📊' },
    { href: '/tokens', label: 'Token管理', icon: '🔑' },
    { href: '/history', label: '任务历史', icon: '📜' },
    ...(authMode === 'admin'
      ? [{ href: '/reconciliation', label: '对账管理', icon: '💰' }]
      : [{ href: '/alerts', label: '预警管理', icon: '⚠️' }]),
  ];

  if (!authMode) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航栏 */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-8">
              <Link href="/dashboard" className="text-xl font-bold text-gray-800">
                VideoFlow 消费管理
              </Link>
              <div className="flex space-x-1">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                      pathname === item.href
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <span className="mr-1">{item.icon}</span>
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                {authMode === 'admin' ? '👤 管理员' : '👤 用户'}
              </span>
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition"
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* 页面内容 */}
      <main>{children}</main>
    </div>
  );
}
