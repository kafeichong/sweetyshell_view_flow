'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BellRing,
  ChevronsUpDown,
  CircleDollarSign,
  Clapperboard,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Users,
} from 'lucide-react';
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
  SidebarRail,
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  authMode?: 'user' | 'admin';
  userName?: string;
  onLogout?: () => void;
}

const navigation = [
  {
    label: '概览',
    items: [
      { href: '/dashboard', label: '消费看板', icon: LayoutDashboard },
    ],
  },
  {
    label: '任务',
    items: [
      { href: '/history', label: '任务历史', icon: History },
      { href: '/showcase', label: '案例广场', icon: Clapperboard },
    ],
  },
];

export function AppSidebar({
  authMode = 'user',
  userName = '用户',
  onLogout,
  ...props
}: AppSidebarProps) {
  const pathname = usePathname();
  const managementItems = authMode === 'user'
    ? [{ href: '/alerts', label: '预警管理', icon: BellRing }]
    : [
        { href: '/users', label: '用户管理', icon: Users },
        { href: '/tokens', label: '用户 Token', icon: ShieldCheck },
        { href: '/billing', label: '账单导入', icon: FileText },
        { href: '/reconciliation', label: '对账管理', icon: CircleDollarSign },
      ];
  const groups = [...navigation, { label: '管理', items: managementItems }];

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <div className="flex aspect-square size-8 items-center justify-center rounded-md border bg-background">
                  <Image src="/favicon.svg" alt="糖果壳" width={24} height={18} className="h-auto w-6" priority />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-normal">糖果壳®SweetyShell®</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                        <Link href={item.href}>
                          <item.icon />
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

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={onLogout} tooltip="退出登录">
              <Avatar className="size-8 rounded-md">
                <AvatarFallback className="rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                  {userName.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-normal">{userName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {authMode === 'admin' ? '管理员' : '普通用户'}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
              <LogOut className="sr-only" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
