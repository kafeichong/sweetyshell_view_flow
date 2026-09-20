'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

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
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  const navItems = [
    { href: '/dashboard', label: '消费看板', icon: '📊', group: '概览' },
    { href: '/history', label: '任务历史', icon: '📜', group: '任务' },
    { href: '/showcase', label: '案例广场', icon: '🎬', group: '任务' },
    { href: '/tokens', label: 'Token管理', icon: '🔑', group: '管理' },
    ...(authMode === 'user'
      ? [
          { href: '/alerts', label: '预警管理', icon: '⚠️', group: '管理' },
        ]
      : []),
    ...(authMode === 'admin'
      ? [
          { href: '/reconciliation', label: '对账管理', icon: '💰', group: '管理' },
        ]
      : []),
  ];

  // 按 group 分组
  const groupedNavItems = navItems.reduce((acc, item) => {
    if (!acc[item.group]) {
      acc[item.group] = [];
    }
    acc[item.group].push(item);
    return acc;
  }, {} as Record<string, typeof navItems>);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar>
          <SidebarHeader className="border-b border-sidebar-border">
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <span className="text-lg">🎬</span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold">Video Flow</span>
                <span className="text-xs text-muted-foreground">Console</span>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            {Object.entries(groupedNavItems).map(([group, items]) => (
              <SidebarGroup key={group}>
                <SidebarGroupLabel>{group}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map((item) => {
                      const isActive = pathname === item.href;
                      return (
                        <SidebarMenuItem key={item.href}>
                          <SidebarMenuButton asChild isActive={isActive}>
                            <Link href={item.href}>
                              <span className="text-lg">{item.icon}</span>
                              <span>{item.label}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border">
            <div className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground">
                    {userName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{userName}</p>
                  {authMode === 'admin' && (
                    <Badge variant="secondary" className="mt-1">管理员</Badge>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="w-full"
              >
                退出登录
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <header className="border-b border-border bg-background sticky top-0 z-10">
            <div className="flex h-16 items-center gap-4 px-6">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-6" />
              <div className="flex-1">
                <h1 className="text-lg font-semibold">
                  {navItems.find(item => item.href === pathname)?.label || 'Dashboard'}
                </h1>
              </div>
            </div>
          </header>

          {/* Main Content */}
          <div className="flex-1 overflow-auto">
            <div className="container mx-auto p-6 max-w-7xl">
              {children}
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
