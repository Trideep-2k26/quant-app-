import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Navbar } from '@/components/Navbar';
import { ControlPanel } from '@/components/ControlPanel';
import { PriceChart } from '@/components/PriceChart';
import { SpreadChart } from '@/components/SpreadChart';
import { StatsCard } from '@/components/StatsCard';
import { AlertsPanel } from '@/components/AlertsPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { startStream, stopStream, getData, getAnalytics, postAlert } from '@/services/api';
import { WS_URL } from '@/utils/constants';

const timeframeToMs = (tf: string): number | null => {
  const match = tf.match(/(\d+)([smhd])/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMap: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return unitMap[unit] ? value * unitMap[unit] : null;
};

const DEFAULT_CANDLE_LOOKBACK = 480;
const MAX_LOOKBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // cap at two weeks of history

const getLookbackDurationMs = (tf: string): number | null => {
  const intervalMs = timeframeToMs(tf);
  if (!intervalMs) {
    return null;
  }

  const duration = intervalMs * DEFAULT_CANDLE_LOOKBACK;
  return Math.min(duration, MAX_LOOKBACK_WINDOW_MS);
};

type Candle = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type SeriesPoint = {
  ts: string;
  value: number;
};

interface AnalyticsSnapshot {
  pair: string;
  hedge_ratio: SeriesPoint[];
  spread: SeriesPoint[];
  zscore: SeriesPoint[];
  rolling_corr: SeriesPoint[];
  adf?: {
    pvalue: number;
    stat: number;
  };
}

interface AlertInput {
  metric: string;
  pair: string;
  operator: string;
  value: number;
}
const Index = () => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [tickCount, setTickCount] = useState(0);
  const [viewMode, setViewMode] = useState<'single' | 'comparison'>('single');
  const [selectedSymbols, setSelectedSymbols] = useState(['BTCUSDT']); // Start with 1 symbol
  const [timeframe, setTimeframe] = useState('1s'); // Default to 1 second for live trading
  const [rollingWindow, setRollingWindow] = useState(20);
  const [regressionType, setRegressionType] = useState('OLS');
  
  // Store price data for multiple symbols
  const [priceData, setPriceData] = useState<Record<string, Candle[]>>({});
  const [analyticsData, setAnalyticsData] = useState<AnalyticsSnapshot | null>(null);
  const [tickerData, setTickerData] = useState<Record<string, {
    priceChange: number;
    priceChangePercent: number;
    lastPrice: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    volume: number;
    quoteVolume: number;
  }>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const analyticsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const tickCounterRef = useRef(0);
  const lastTickUpdateRef = useRef(Date.now());
  
  // Add throttling refs for price updates - Rapid updates like Binance
  const lastPriceUpdateRef = useRef<Record<string, number>>({});
    const PRICE_UPDATE_THROTTLE_MS = 100; // Throttle for price data updates (100ms = 10 updates/sec for smooth building)
  
  // Pending updates buffer
  const pendingUpdatesRef = useRef<Record<string, {
    price: number;
    qty: number;
    ts: string;
    time: Date;
  }>>({});
  
  // RAF for smooth batched updates
  const rafIdRef = useRef<number | null>(null);

  const getBucketedTimestamp = useCallback((date: Date, tf: string) => {
    const bucket = new Date(date);
    bucket.setUTCMilliseconds(0);

    // Live mode uses per-second buckets for real-time candles
    if (tf === 'live') {
      bucket.setUTCSeconds(bucket.getUTCSeconds(), 0);
      return bucket.toISOString();
    }

    const match = tf.match(/(\d+)([a-zA-Z]+)/);
    if (!match) {
      bucket.setSeconds(0, 0);
      return bucket.toISOString();
    }

    const [, sizeStr, unit] = match;
    const size = Number(sizeStr);

    if (unit === 's') {
      const seconds = Math.floor(bucket.getUTCSeconds() / size) * size;
      bucket.setUTCSeconds(seconds, 0);
    } else if (unit === 'm') {
      const minutes = Math.floor(bucket.getUTCMinutes() / size) * size;
      bucket.setUTCSeconds(0, 0);
      bucket.setUTCMinutes(minutes);
    } else if (unit === 'h') {
      const hours = Math.floor(bucket.getUTCHours() / size) * size;
      bucket.setUTCSeconds(0, 0);
      bucket.setUTCMinutes(0);
      bucket.setUTCHours(hours);
    } else {
      bucket.setUTCSeconds(0, 0);
    }

    return bucket.toISOString();
  }, []);

  // Auto-switch to comparison view when 2 symbols are selected
  useEffect(() => {
    if (selectedSymbols.length === 2 && isStreaming) {
      console.log('[ViewMode] Auto-switching to comparison view for 2 symbols');
      setViewMode('comparison');
    } else if (selectedSymbols.length !== 2 && viewMode === 'comparison') {
      console.log('[ViewMode] Switching back to single view');
      setViewMode('single');
    }
  }, [selectedSymbols.length, isStreaming]);

  // Fetch initial data for all selected symbols
  useEffect(() => {
    if (!isStreaming) {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      setPriceData({});
      setAnalyticsData(null);
      setTickerData({});
      return;
    }

    const fetchData = async () => {
      if (selectedSymbols.length > 0) {
        const toTs = new Date().toISOString();
        const lookbackDuration = getLookbackDurationMs(timeframe);
        const fromTs = lookbackDuration
          ? new Date(Date.now() - lookbackDuration).toISOString()
          : undefined;

        const dataPromises = selectedSymbols.map(symbol =>
          getData(symbol, timeframe, fromTs, toTs).catch(err => {
            console.error(`Error fetching ${symbol}:`, err);
            return [];
          })
        );

        const results = await Promise.all(dataPromises);
        const newPriceData: Record<string, Candle[]> = {};
        selectedSymbols.forEach((symbol, index) => {
          if (results[index] && results[index].length > 0) {
            newPriceData[symbol] = results[index]
              .map(candle => ({
                ...candle,
                ts: new Date(candle.ts).toISOString(),
              }))
              .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
          }
        });

        setPriceData(newPriceData);
      }

      // Calculate analytics for single currency (z-score of price itself)
      if (selectedSymbols.length >= 1) {
        try {
          // Use single symbol or pair format
          const pair = selectedSymbols.length === 1 
            ? `${selectedSymbols[0]}-${selectedSymbols[0]}` // Self-comparison for z-score
            : `${selectedSymbols[0]}-${selectedSymbols[1]}`; // Pair comparison
          
          const analytics = await getAnalytics(pair, timeframe, rollingWindow, regressionType);
          setAnalyticsData(analytics);
        } catch (error) {
          console.error('Error fetching analytics:', error);
        }
      }
    };

    fetchData();

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [selectedSymbols, timeframe, rollingWindow, regressionType, isStreaming]);

  // WebSocket connection for live updates
  useEffect(() => {
    if (isStreaming) {
      // Connect to real backend WebSocket
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log('WebSocket connected to backend');
        // Subscribe to selected symbols
        ws.send(JSON.stringify({
          action: 'subscribe',
          symbols: selectedSymbols
        }));
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          // Handle trade/tick messages from backend
          if (message.type === 'trade' || message.type === 'tick') {
            // Backend sends tick data directly (not in message.data)
            const tick = message.data || message; // Support both formats
            const tickSymbol = tick.symbol || message.symbol;
            const tickPrice = tick.price || message.price;
            
            // Validate symbol and price
            if (!tickSymbol || typeof tickPrice !== 'number') {
              return;
            }
            
            // Only process ticks for selected symbols
            if (!selectedSymbols.includes(tickSymbol)) {
              return; // Ignore ticks from unselected symbols
            }
            
            // Count ticks for selected symbols
            tickCounterRef.current += 1;
            const now = Date.now();
            if (now - lastTickUpdateRef.current > 100) {
              setTickCount(tickCounterRef.current);
              lastTickUpdateRef.current = now;
            }
            
            const tickQty = tick.qty || message.qty || 0;
            const tickTs = tick.ts || message.ts;
            const tickTime = new Date(tickTs);
            
            // Update ticker data from trade price (for real-time price display)
            setTickerData(prev => {
              const existing = prev[tickSymbol];
              const lastPrice = tickPrice;
              
              // If we have existing data, calculate change from open price
              if (existing && existing.openPrice) {
                const priceChange = lastPrice - existing.openPrice;
                const priceChangePercent = (priceChange / existing.openPrice) * 100;
                
                return {
                  ...prev,
                  [tickSymbol]: {
                    ...existing,
                    lastPrice,
                    priceChange,
                    priceChangePercent,
                    highPrice: Math.max(existing.highPrice || lastPrice, lastPrice),
                    lowPrice: Math.min(existing.lowPrice || lastPrice, lastPrice),
                  },
                };
              }
              
              // Initialize ticker data if not exists
              return {
                ...prev,
                [tickSymbol]: {
                  lastPrice,
                  priceChange: 0,
                  priceChangePercent: 0,
                  openPrice: lastPrice,
                  highPrice: lastPrice,
                  lowPrice: lastPrice,
                  volume: 0,
                  quoteVolume: 0,
                },
              };
            });
            
            // Throttle price data updates to reduce re-renders
            const lastUpdate = lastPriceUpdateRef.current[tickSymbol] || 0;
            
            // Store the pending update
            pendingUpdatesRef.current[tickSymbol] = {
              price: tickPrice,
              qty: tickQty,
              ts: tickTs,
              time: tickTime,
            };
            
            // Only process if enough time has passed (100ms throttle for smooth building)
            if (now - lastUpdate < PRICE_UPDATE_THROTTLE_MS) {
              return; // Skip this update, will use the latest pending update later
            }
            
            // Process the most recent pending update
            const pendingUpdate = pendingUpdatesRef.current[tickSymbol];
            if (!pendingUpdate) return;
            
            lastPriceUpdateRef.current[tickSymbol] = now;
            
            const effectiveTimeframe = timeframe || '1m';
            const bucketTs = getBucketedTimestamp(pendingUpdate.time, effectiveTimeframe);
            
            // Update price data for the specific symbol
            setPriceData(prev => {
              const symbolData = prev[tickSymbol] || [];
              
              // Check if we need to update at all
              if (symbolData.length > 0) {
                const last = symbolData[symbolData.length - 1];

                if (last.ts === bucketTs) {
                  // Update existing candle in same bucket
                  const updatedLast = {
                    ...last,
                    close: pendingUpdate.price,
                    high: Math.max(last.high, pendingUpdate.price),
                    low: Math.min(last.low, pendingUpdate.price),
                    volume: (last.volume || 0) + pendingUpdate.qty,
                  };
                  
                  // Use ultra-sensitive threshold for continuous candle building
                  const priceThreshold = Math.max(last.close * 0.000001, 0.001); // 0.0001% or minimum 0.001
                  const volumeThreshold = 0.0001;
                  
                  const closeChanged = Math.abs(updatedLast.close - last.close) > priceThreshold;
                  const highChanged = Math.abs(updatedLast.high - last.high) > priceThreshold;
                  const lowChanged = Math.abs(updatedLast.low - last.low) > priceThreshold;
                  const volumeChanged = Math.abs(updatedLast.volume - last.volume) > volumeThreshold;
                  
                  if (!closeChanged && !highChanged && !lowChanged && !volumeChanged) {
                    return prev; // No meaningful change, keep everything stable
                  }
                  
                  // Only create new array when values changed
                  const newData = [...symbolData];
                  newData[newData.length - 1] = updatedLast;
                  
                  return {
                    ...prev,
                    [tickSymbol]: newData,
                  };
                } else if (new Date(bucketTs).getTime() > new Date(last.ts).getTime()) {
                  // Append new bucket candle
                  const tfMs = timeframeToMs(effectiveTimeframe);
                  const lookbackMs = getLookbackDurationMs(effectiveTimeframe);
                  const maxCandles = tfMs && lookbackMs
                    ? Math.ceil(lookbackMs / tfMs) + 5
                    : DEFAULT_CANDLE_LOOKBACK;

                  const newData = [
                    ...symbolData,
                    {
                      ts: bucketTs,
                      open: pendingUpdate.price,
                      high: pendingUpdate.price,
                      low: pendingUpdate.price,
                      close: pendingUpdate.price,
                      volume: pendingUpdate.qty,
                    },
                  ]
                    .slice(-maxCandles)
                    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

                  return {
                    ...prev,
                    [tickSymbol]: newData,
                  };
                }
                
                return prev; // No update needed
              } else {
                // Initialize first candle from tick
                return {
                  ...prev,
                  [tickSymbol]: [{
                    ts: bucketTs,
                    open: pendingUpdate.price,
                    high: pendingUpdate.price,
                    low: pendingUpdate.price,
                    close: pendingUpdate.price,
                    volume: pendingUpdate.qty,
                  }],
                };
              }
            });
          } else if (message.type === 'ticker') {
            // Handle 24h ticker updates from Binance - HEAVILY THROTTLED
            const ticker = message.data || message;
            const tickerSymbol = ticker.symbol || message.symbol;
            
            if (tickerSymbol) {
              const resolveNumber = (value: unknown, fallback: unknown = 0) => {
                if (typeof value === 'number') return value;
                const parsed = Number(value ?? fallback ?? 0);
                return Number.isFinite(parsed) ? parsed : 0;
              };

              const newTickerData = {
                priceChange: resolveNumber(ticker.priceChange, message.priceChange),
                priceChangePercent: resolveNumber(ticker.priceChangePercent, message.priceChangePercent),
                lastPrice: resolveNumber(ticker.lastPrice, message.lastPrice),
                openPrice: resolveNumber(ticker.openPrice, message.openPrice),
                highPrice: resolveNumber(ticker.highPrice, message.highPrice),
                lowPrice: resolveNumber(ticker.lowPrice, message.lowPrice),
                volume: resolveNumber(ticker.volume, message.volume),
                quoteVolume: resolveNumber(ticker.quoteVolume, message.quoteVolume),
              };

              setTickerData(prev => {
                const existing = prev[tickerSymbol];
                // Update with real 24h ticker data (less throttling for smooth updates)
                if (existing && 
                    Math.abs(existing.lastPrice - newTickerData.lastPrice) < 0.01 &&
                    Math.abs(existing.priceChangePercent - newTickerData.priceChangePercent) < 0.01) {
                  return prev; // No meaningful change
                }
                
                return {
                  ...prev,
                  [tickerSymbol]: newTickerData,
                };
              });
            }
          } else if (message.type === 'analytics') {
            setAnalyticsData(message.data || message);
          } else if (message.type === 'alert') {
            toast.warning(`Alert: ${message.message}`);
          } else if (message.type === 'subscription') {
            console.log('Subscription status:', message.status, message.symbols);
            toast.success(`Subscribed to ${message.symbols.join(', ')}`);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        toast.error('WebSocket connection error');
      };
      
      ws.onclose = () => {
        console.log('WebSocket disconnected');
      };
      
      // Refresh analytics every 3 seconds when streaming (increased frequency)
      const fetchAnalytics = async () => {
        if (selectedSymbols.length === 2) { // Only fetch analytics when 2 symbols are selected
          try {
            const pair = `${selectedSymbols[0]}-${selectedSymbols[1]}`; // Pair comparison
            
            console.log(`[Analytics] Fetching for ${pair} (tf: ${timeframe}, window: ${rollingWindow}, method: ${regressionType})`);
            const analytics = await getAnalytics(pair, timeframe, rollingWindow, regressionType);
            if (analytics) {
              const zscoreCount = analytics.zscore?.length || 0;
              const spreadCount = analytics.spread?.length || 0;
              const corrCount = analytics.rolling_corr?.length || 0;
              const latestZScore = zscoreCount > 0 ? analytics.zscore[zscoreCount - 1].value : 'N/A';
              const latestCorr = corrCount > 0 ? analytics.rolling_corr[corrCount - 1].value : 'N/A';
              const latestSpread = spreadCount > 0 ? analytics.spread[spreadCount - 1].value : 'N/A';
              console.log(`[Analytics] ✅ Received - Spread: ${spreadCount} points, Z-score: ${zscoreCount} points, Corr: ${corrCount} points`);
              console.log(`[Analytics] Latest values - Spread: ${latestSpread}, Z: ${latestZScore}, Corr: ${latestCorr}`);
              setAnalyticsData(analytics);
            } else {
              console.warn('[Analytics] ⚠️ No analytics data received - backend returned null/undefined');
              setAnalyticsData(null);
            }
          } catch (error) {
            console.error('[Analytics] ❌ Error fetching analytics:', error);
            if (error instanceof Error) {
              console.error('[Analytics] Error details:', error.message);
            }
            setAnalyticsData(null);
          }
        } else {
          // Clear analytics when not 2 symbols
          if (analyticsData !== null) {
            console.log(`[Analytics] Clearing analytics (only ${selectedSymbols.length} symbol(s) selected)`);
            setAnalyticsData(null);
          }
        }
      };
      
      // Fetch analytics immediately
      fetchAnalytics();
      
      // Then refresh every 3 seconds (increased from 5)
      analyticsIntervalRef.current = setInterval(fetchAnalytics, 3000);
    } else {
      // Disconnect WebSocket
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (analyticsIntervalRef.current) {
        clearInterval(analyticsIntervalRef.current);
        analyticsIntervalRef.current = null;
      }
    };
  }, [isStreaming, selectedSymbols, timeframe, rollingWindow, regressionType, getBucketedTimestamp]);

  const handleStartStream = async () => {
    try {
      await startStream(selectedSymbols);
      setIsStreaming(true);
      setTickCount(0);
      setPriceData({});
      setTickerData({});
      setAnalyticsData(null);
      // Keep current timeframe for analytics but use 6h buckets for display
      toast.success('Stream started - Live 6h candles');
    } catch (error) {
      toast.error('Failed to start stream');
    }
  };

  const handleStopStream = async () => {
    try {
      await stopStream(selectedSymbols);
      setIsStreaming(false);
      setPriceData({});
      setTickerData({});
      setAnalyticsData(null);
      toast.success('Stream stopped');
    } catch (error) {
      toast.error('Failed to stop stream');
    }
  };

  const handleClearBuffer = () => {
    setPriceData({});
    setAnalyticsData(null);
    setTickCount(0);
    toast.info('Buffer cleared');
  };

  const handleDownloadData = () => {
    if (!analyticsData || analyticsData.spread.length === 0) {
      toast.error('No data to download');
      return;
    }
    
    // Simple CSV export
    const csvData = analyticsData.spread.map((s, i) => ({
      timestamp: s.ts,
      spread: s.value,
      zscore: analyticsData.zscore[i]?.value ?? 0,
      correlation: analyticsData.rolling_corr[i]?.value ?? 0,
    }));

    const csvHeader = Object.keys(csvData[0]).join(',');
    const csvRows = csvData.map(row => Object.values(row).join(','));
    const csv = [csvHeader, ...csvRows].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success('Data exported');
  };

  const handleRunADF = () => {
    // Check if streaming and 2 symbols selected
    if (!isStreaming) {
      toast.warning('Please start streaming data first');
      return;
    }
    
    if (selectedSymbols.length !== 2) {
      toast.warning('ADF test requires exactly 2 symbols. Please select 2 symbols from the left panel.');
      return;
    }
    
    if (viewMode !== 'comparison') {
      toast.info('Switching to Analytics View to show ADF test results...');
      setViewMode('comparison');
    }
    
    if (!analyticsData?.adf) {
      toast.warning('No ADF data available yet. Analytics are being computed in the background. Please wait a moment and try again.');
      return;
    }
    
    const { pvalue, stat } = analyticsData.adf;
    const isStationary = pvalue < 0.05;
    const strength = pvalue < 0.01 ? 'strongly' : pvalue < 0.05 ? 'weakly' : 'not';
    
    const pairName = `${selectedSymbols[0]}-${selectedSymbols[1]}`;
    const message = isStationary
      ? `✅ Spread is ${strength} stationary (mean-reverting)\n\nPair: ${pairName}\nADF Statistic: ${stat.toFixed(4)}\nP-Value: ${pvalue.toFixed(4)} ${pvalue < 0.01 ? '(< 0.01)' : '(< 0.05)'}\n\nInterpretation: The spread between the two assets exhibits ${strength} mean-reverting behavior, making it ${strength === 'strongly' ? 'highly' : ''} suitable for pairs trading strategies.`
      : `⚠️ Spread is NOT stationary\n\nPair: ${pairName}\nADF Statistic: ${stat.toFixed(4)}\nP-Value: ${pvalue.toFixed(4)} (> 0.05)\n\nInterpretation: The spread does not exhibit statistically significant mean-reverting behavior. Mean reversion strategies may not be effective for this pair.`;
    
    if (isStationary) {
      toast.success(message, { duration: 8000 });
    } else {
      toast.warning(message, { duration: 8000 });
    }
  };

  const handleAddAlert = async ({ metric, pair, operator, value }: AlertInput) => {
    try {
      if (!isStreaming) {
        toast.warning('Please start streaming data before creating alerts');
        return;
      }
      
      // Validate metric requirements
      if (['zscore', 'spread', 'correlation'].includes(metric.toLowerCase())) {
        if (selectedSymbols.length !== 2) {
          toast.warning(`${metric} alerts require exactly 2 symbols. Please select 2 symbols from the left panel.`);
          return;
        }
        if (!pair.includes('-')) {
          toast.error('Pair format should be SYMBOL1-SYMBOL2 (e.g., BTCUSDT-ETHUSDT)');
          return;
        }
      }
      
      await postAlert({ metric, pair, op: operator, value });
      toast.success(`Alert created: ${metric} ${operator} ${value} for ${pair}`, { duration: 4000 });
    } catch (error) {
      console.error('Failed to create alert:', error);
      toast.error(`Failed to create alert: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleTimeframeChange = (tf: string) => {
    setTimeframe(tf);
    setPriceData({});
  };

  const currentSpread = analyticsData?.spread[analyticsData.spread.length - 1]?.value || 0;
  const currentZScore = analyticsData?.zscore[analyticsData.zscore.length - 1]?.value || 0;
  const currentCorr = analyticsData?.rolling_corr[analyticsData.rolling_corr.length - 1]?.value || 0;
  const adfPValue = analyticsData?.adf?.pvalue || 0;

  // Memoize chart data to prevent unnecessary re-renders
  const stableChartData = useMemo(() => {
    const result: Record<string, Candle[]> = {};
    Object.keys(priceData).forEach(symbol => {
      result[symbol] = priceData[symbol] || [];
    });
    return result;
  }, [priceData]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar 
        isStreaming={isStreaming} 
        tickCount={tickCount} 
        selectedSymbols={selectedSymbols}
        tickerData={tickerData}
      />
      
      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left Column - Controls */}
          <div className="lg:col-span-1 space-y-6">
            <ControlPanel
              isStreaming={isStreaming}
              onStartStream={handleStartStream}
              onStopStream={handleStopStream}
              onClearBuffer={handleClearBuffer}
              onDownloadData={handleDownloadData}
              selectedSymbols={selectedSymbols}
              onSymbolsChange={setSelectedSymbols}
              timeframe={timeframe}
              onTimeframeChange={handleTimeframeChange}
              rollingWindow={rollingWindow}
              onRollingWindowChange={setRollingWindow}
              regressionType={regressionType}
              onRegressionTypeChange={setRegressionType}
              onRunADF={handleRunADF}
            />
            
            <AlertsPanel onAddAlert={handleAddAlert} />
          </div>

          {/* Right Column - Charts and Stats */}
          <div className="lg:col-span-3 space-y-6">
            {/* Mode Toggle - Only show when 2 symbols selected */}
            {selectedSymbols.length === 2 && (
              <Card className="bg-gradient-card border-border/50">
                <CardContent className="pt-6">
                  <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'single' | 'comparison')}>
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="single">Price Charts</TabsTrigger>
                      <TabsTrigger value="comparison">Analytics View</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <p className="text-xs text-muted-foreground mt-2">
                    {viewMode === 'single' 
                      ? 'View live candlestick charts for both symbols with moving averages'
                      : 'View z-score, spread, correlation and statistical analysis for the pair'}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Price Charts View */}
            {(selectedSymbols.length < 2 || viewMode === 'single') && (
              <>
                {selectedSymbols.length === 0 ? (
                  <Card className="bg-gradient-card border-border/50 shadow-card">
                    <CardContent className="flex items-center justify-center h-[500px]">
                      <div className="text-center text-muted-foreground">
                        <p className="text-lg mb-2">No symbols selected</p>
                        <p className="text-sm">Select 1 or 2 symbols from the left panel to view charts</p>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    {/* Show Price Chart for each selected symbol */}
                    {selectedSymbols.map((symbol, index) => (
                      <PriceChart
                        key={symbol}
                        data={stableChartData[symbol] || []}
                        symbol={symbol}
                        timeframe={timeframe}
                        onTimeframeChange={handleTimeframeChange}
                        isLive={isStreaming}
                        onStartLive={index === 0 ? handleStartStream : undefined}
                        onStopLive={index === 0 ? handleStopStream : undefined}
                        tickerData={tickerData[symbol] || null}
                      />
                    ))}
                  </>
                )}
              </>
            )}

            {/* Analytics View - Only available with 2 symbols */}
            {selectedSymbols.length === 2 && viewMode === 'comparison' && (
              <>
                {/* Stats Cards for Analytics */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatsCard title="Spread" value={currentSpread} decimals={2} />
                  <StatsCard title="Z-Score" value={currentZScore} decimals={2} />
                  <StatsCard title="Correlation" value={currentCorr} decimals={4} />
                  <StatsCard title="ADF p-value" value={adfPValue} decimals={4} />
                </div>

                {/* Spread & Z-Score Detail Chart */}
                {analyticsData && analyticsData.spread && analyticsData.spread.length > 0 ? (
                  <SpreadChart
                    spread={analyticsData.spread}
                    zscore={analyticsData.zscore}
                    pair={analyticsData.pair}
                  />
                ) : (
                  <Card className="bg-gradient-card border-border/50 shadow-card">
                    <CardHeader>
                      <CardTitle className="text-lg">
                        Spread & Z-Score - {selectedSymbols[0]}-{selectedSymbols[1]}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex items-center justify-center h-[400px]">
                      <div className="text-center text-muted-foreground">
                        <p className="text-lg mb-2">📊 Collecting data...</p>
                        <p className="text-sm">Analytics will appear once enough historical data is loaded</p>
                        <p className="text-xs mt-2 text-muted-foreground/70">This usually takes 10-30 seconds after starting stream</p>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;
