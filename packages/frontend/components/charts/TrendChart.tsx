'use client';

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { ConsumptionTrend } from '@/types/api';

interface TrendChartProps {
  data: ConsumptionTrend[];
}

export default function TrendChart({ data }: TrendChartProps) {
  // 转换数据格式供Recharts使用
  const chartData = data.map((item) => ({
    date: item.dayKey.slice(5), // "2026-09-17" -> "09-17"
    fullDate: item.dayKey,
    amount: parseFloat(item.totalCny),
    tasks: item.taskCount,
  }));

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            stroke="#6b7280"
            fontSize={12}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={30}
          />
          <YAxis
            stroke="#6b7280"
            fontSize={12}
            tickLine={false}
            width={60}
            tickFormatter={(value) => {
              if (value >= 1000) return `¥${(value / 1000).toFixed(1)}k`;
              return `¥${value}`;
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '8px 12px',
              fontSize: '12px',
            }}
            formatter={(value, name) => {
              const numValue = typeof value === 'number' ? value : parseFloat(String(value || '0'));
              if (name === 'amount') return [`¥${numValue.toFixed(2)}`, '消费金额'];
              if (name === 'tasks') return [`${numValue}个`, '任务数'];
              return [numValue, name];
            }}
            labelFormatter={(label) => {
              const item = chartData.find((d) => d.date === label);
              return item ? `日期: ${item.fullDate}` : `日期: ${label}`;
            }}
          />
          <Line
            type="monotone"
            dataKey="amount"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ fill: '#3b82f6', r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
