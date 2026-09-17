import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
});

// 请求拦截器：添加认证header
api.interceptors.request.use((config) => {
  // 检查是否为客户端环境
  if (typeof window !== 'undefined') {
    const authMode = localStorage.getItem('auth_mode'); // 'user' | 'admin'
    const token = localStorage.getItem('auth_token');

    if (authMode === 'user' && token) {
      config.headers.Authorization = `Bearer ${token}`;
    } else if (authMode === 'admin' && token) {
      config.headers['x-admin-token'] = token;
    }
  }

  return config;
});

// 响应拦截器：处理401/403
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (typeof window !== 'undefined') {
      if (error.response?.status === 401 || error.response?.status === 403) {
        // 清除token并跳转到登录页
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_mode');
        localStorage.removeItem('auth_user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
