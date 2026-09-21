'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // 检查是否已登录
    const authToken = localStorage.getItem('auth_token');
    const authMode = localStorage.getItem('auth_mode');

    if (authToken && authMode) {
      // 已登录，跳转到dashboard
      router.push('/dashboard');
    } else {
      // 未登录，跳转到登录页
      router.push('/login');
    }
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-muted-foreground">加载中...</div>
    </div>
  );
}
