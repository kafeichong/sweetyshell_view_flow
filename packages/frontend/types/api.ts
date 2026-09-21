// API响应类型定义

// 通用响应
export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
  message?: string;
}

// 用户/Actor相关
export interface Actor {
  actorId: string;
  name: string;
  status: string;
  dailyLimitCny?: string;
  monthlyLimitCny?: string;
}

export interface ConsumptionPeriod {
  settled: string;
  reserved: string;
  total: string;
  taskCount: number;
  limit?: string | null;
  remaining?: string | null;
  alerts?: Array<{
    type: string;
    threshold: string;
    message: string;
  }>;
}

// 消费概览
export interface ConsumptionOverview {
  daily: ConsumptionPeriod;
  monthly: ConsumptionPeriod;
}

// 消费趋势
export interface ConsumptionTrend {
  date: string;
  amount: string;
  taskCount: number;
}

export interface ConsumptionTrendsResponse {
  trends: ConsumptionTrend[];
}

export interface AdminConsumptionSummary {
  monthKey: string;
  totalSettled: string;
  totalReserved: string;
  totalTasks: number;
  byActor: Array<{
    actorId: string;
    name: string;
    settled: string;
    taskCount: number;
  }>;
}

// Token信息
export interface TokenInfo {
  totalRequests: number;
  last24hRequests: number;
  last7dRequests: number;
  mostUsedEndpoint?: string;
  lastUsedAt?: string;
}

// Token使用日志
export interface TokenUsageLog {
  id: string;
  endpoint: string;
  method: string;
  statusCode: number;
  ipAddress?: string;
  createdAt: string;
}

export interface TokenLogsResponse {
  logs: TokenUsageLog[];
  hasMore: boolean;
  nextCursor?: string;
}

// 对账记录
export interface ReconciliationRecord {
  id: string;
  monthKey: string;
  actorId?: string;
  actorName?: string;
  systemTotalCny: string;
  providerBillCny: string;
  varianceCny: string;
  variancePercent: string;
  notes?: string;
  reconciledBy: string;
  reconciledAt: string;
}

// 费用预警
export interface AlertConfig {
  type: 'daily_threshold' | 'monthly_threshold';
  enabled: boolean;
  thresholdCny: string;
}

export interface AlertsConfig {
  daily?: AlertConfig;
  monthly?: AlertConfig;
}
