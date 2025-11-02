import axios from 'axios';
import { API_BASE_URL } from '@/utils/constants';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// API functions
export const getSymbols = async (): Promise<string[]> => {
  try {
    const response = await api.get('/symbols');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch symbols:', error);
    return [];
  }
};

export const startStream = async (symbols: string[], tickMode = true) => {
  try {
    const response = await api.post('/stream/start', {
      symbols,
      tick_mode: tickMode,
    });
    return response.data;
  } catch (error) {
    console.error('Failed to start stream:', error);
    throw error;
  }
};

export const stopStream = async (symbols: string[]) => {
  try {
    const response = await api.post('/stream/stop', { symbols });
    return response.data;
  } catch (error) {
    console.error('Failed to stop stream:', error);
    throw error;
  }
};

export const getData = async (
  symbol: string,
  timeframe: string = '1m',
  from?: string,
  to?: string
) => {
  try {
    const response = await api.get(`/data/${symbol}`, {
      params: { tf: timeframe, from, to },
    });
    return response.data;
  } catch (error) {
    console.error('Failed to fetch data:', error);
    return [];
  }
};

export const getAnalytics = async (
  pair: string,
  timeframe: string = '1m',
  window: number = 60,
  regression: string = 'OLS'
) => {
  try {
    const response = await api.get('/analytics/pair', {
      params: { pair, tf: timeframe, window, regression },
    });
    return response.data;
  } catch (error) {
    console.error('Failed to fetch analytics:', error);
    throw error;
  }
};

export const postAlert = async (alertData: {
  metric: string;
  pair: string;
  op: string;
  value: number;
}) => {
  try {
    const response = await api.post('/alerts', alertData);
    return response.data;
  } catch (error) {
    console.error('Failed to create alert:', error);
    throw error;
  }
};

export const exportData = async (
  pair: string,
  timeframe: string = '1m',
  format: string = 'csv'
) => {
  try {
    const response = await api.get('/export', {
      params: { pair, tf: timeframe, format },
      responseType: 'blob',
    });
    return response.data;
  } catch (error) {
    console.error('Failed to export data:', error);
    throw error;
  }
};
