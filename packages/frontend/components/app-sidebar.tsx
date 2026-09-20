'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  authMode?: 'user' | 'admin';
  userName?: string;
  onLogout?: () => void;
}

export function AppSidebar({ authMode = 'user', userName = '用户', onLogout, ...props }: AppSidebarProps) {
  const pathname = usePathname();

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
    <Sidebar {...props}>
      <SidebarHeader className="border-b">
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

      <SidebarFooter className="border-t">
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
            onClick={onLogout}
            className="w-full"
          >
            退出登录
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
