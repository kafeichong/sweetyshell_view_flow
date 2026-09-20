'use client';

import { Card } from '@appica/ui-react/card';

export default function ShowcasePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto">
          <Card className="p-8 text-center">
            <div className="mb-6">
              <svg
                className="mx-auto h-16 w-16 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
            </div>

            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              案例广场
            </h1>

            <p className="text-lg text-gray-600 dark:text-gray-300 mb-6">
              功能开发中，敬请期待
            </p>

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 text-left">
              <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                即将推出的功能
              </h3>
              <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-2">
                <li>• 查看团队成员的已完成视频生成案例</li>
                <li>• 学习和参考其他成员的提示词和参数配置</li>
                <li>• 促进团队协作和知识共享</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
