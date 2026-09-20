'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { AppSidebar } from '@/components/app-sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

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

    const updateAuthState = window.setTimeout(() => {
      setAuthMode(mode);
      setUserName(mode === 'admin' ? '管理员' : '用户');
    }, 0);

    return () => window.clearTimeout(updateAuthState);
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
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  // 页面标题映射
  const pageTitles: Record<string, string> = {
    '/dashboard': '消费看板',
    '/history': '任务历史',
    '/showcase': '案例广场',
    '/tokens': 'Token管理',
    '/alerts': '预警管理',
    '/reconciliation': '对账管理',
  };

  const currentTitle = pageTitles[pathname] || '控制台';

  return (
    <SidebarProvider>
      <AppSidebar authMode={authMode} userName={userName} onLogout={handleLogout} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{currentTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
