import { useCallback, useEffect, useMemo, useState, memo, useRef } from 'react';
import Plot from 'react-plotly.js';
import { ArrowDownRight, ArrowUpRight, Dot, Star, StarOff } from 'lucide-react';
import type { PlotData, PlotRelayoutEvent, PlotlyHTMLElement } from 'plotly.js';

import { Card, CardContent, CardHeader } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { AssetLogo } from './AssetLogo';

import { cn } from '@/lib/utils';
import {
  formatCompactCurrency,
  formatCompactNumber,
  formatNumber,
  formatPrice,
  formatSignedPercent,
} from '@/utils/formatters';
import { getAssetMeta } from '@/utils/assets';

const MOVING_AVERAGE_WINDOWS = [7, 25, 99] as const;
const MOVING_AVERAGE_COLORS = ['#facc15', '#c084fc', '#60a5fa'];
const DEFAULT_TIMEFRAME_OPTIONS = [
  { value: '1s', label: '1s' },
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '14h', label: '14h' },
] as const;

type TimeframeOption = typeof DEFAULT_TIMEFRAME_OPTIONS[number];

type PriceData = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TickerSnapshot = {
  priceChange: number;
  priceChangePercent: number;
  lastPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
};

interface PriceChartProps {
  data: PriceData[];
  symbol: string;
  timeframe: string;
  onTimeframeChange?: (value: string) => void;
  timeframeOptions?: ReadonlyArray<TimeframeOption>;
  isLive?: boolean;
  onStartLive?: () => void;
  onStopLive?: () => void;
  showLiveToggle?: boolean;
  tickerData?: TickerSnapshot | null;
}

const computeSMA = (values: number[], window: number): Array<number | null> => {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (window <= 0 || values.length === 0) {
    return result;
  }

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) {
      sum -= values[i - window];
    }
    if (i >= window - 1) {
      result[i] = sum / window;
    }
  }

  return result;
};
const computeCandleWidth = (timestamps: string[], timeframe: string, visibleCandleCount?: number): number | undefined => {
  if (!timestamps || timestamps.length < 2) return undefined;

  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const current = Date.parse(timestamps[i]);
    const previous = Date.parse(timestamps[i - 1]);
    const delta = current - previous;
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) return undefined;

  const average = deltas.reduce((acc, value) => acc + value, 0) / deltas.length;
  
  // Dynamic width based on zoom level - smooth continuous scaling
  let widthMultiplier: number;
  if (timeframe === '1s') {
    // 1 second: Wide candles like Binance - perfect balance between width and spacing
    widthMultiplier = 0.75; // Optimal for 1s - wide but not overlapping
  } else {
    // Smooth continuous scaling based on visible candle count
    if (visibleCandleCount) {
      // Use logarithmic scaling for smooth transitions
      // Binance/Groww style: very narrow candles, tight spacing - professional look
      // Maps: 20 candles -> 0.28, 50 -> 0.22, 100 -> 0.18, 200 -> 0.12, 500+ -> 0.08
      const minWidth = 0.08; // Very narrow for professional Binance/Groww look
      const maxWidth = 0.28; // Much lower max for slim candles
      
      // Inverse logarithmic function for smooth zoom response
      if (visibleCandleCount <= 20) {
        // Very zoomed in - maximum width
        widthMultiplier = maxWidth;
      } else if (visibleCandleCount >= 500) {
        // Very zoomed out - minimum width
        widthMultiplier = minWidth;
      } else {
        // Smooth interpolation using logarithmic curve
        // This provides natural feeling zoom transitions
        const logMin = Math.log(20);
        const logMax = Math.log(500);
        const logCurrent = Math.log(visibleCandleCount);
        const normalizedPosition = (logCurrent - logMin) / (logMax - logMin);
        
        // Interpolate width (inverted - more candles = narrower)
        widthMultiplier = maxWidth - (normalizedPosition * (maxWidth - minWidth));
      }
    } else {
      // Default width when zoom level unknown - very narrow for Binance/Groww style
      widthMultiplier = 0.12;
    }
  }
  
  return average * widthMultiplier;
};

interface ChartCanvasProps {
  data: PriceData[];
  symbol: string;
  timeframe: string;
}

const MAX_VISIBLE_CANDLES = 500;

const ChartCanvas = memo(({ data, symbol, timeframe }: ChartCanvasProps) => {
  const [candleWidth, setCandleWidth] = useState<number | undefined>();
  const [visibleCandleCount, setVisibleCandleCount] = useState<number | undefined>();
  const prevDataRef = useRef<PriceData[]>([]);
  const plotRef = useRef<PlotlyHTMLElement | null>(null);
  const zoomTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const visibleData = useMemo<PriceData[]>(() => {
    if (!data || data.length === 0) return [];
    if (data.length <= MAX_VISIBLE_CANDLES) return data;
    return data.slice(data.length - MAX_VISIBLE_CANDLES);
  }, [data]);

  const dataLength = visibleData.length;

  useEffect(() => {
    if (!visibleData || dataLength < 2) {
      setCandleWidth(undefined);
      return;
    }

    if (dataLength < 10 || dataLength % 10 === 0) {
      const width = computeCandleWidth(visibleData.map(candle => candle.ts), timeframe, visibleCandleCount);
      setCandleWidth(width);
    }
  }, [visibleData, dataLength, timeframe, visibleCandleCount]);

  useEffect(() => {
    setCandleWidth(undefined);
    setVisibleCandleCount(undefined);
  }, [symbol, timeframe]);

  const timestamps = useMemo(() => visibleData.map(candle => candle.ts), [visibleData]);

  const volumeColors = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return [] as string[];
    return visibleData.map((candle, index) => {
      const previousClose = index > 0 ? visibleData[index - 1].close : candle.open;
      return candle.close >= previousClose
        ? 'rgba(14, 203, 129, 0.6)'
        : 'rgba(246, 70, 93, 0.6)';
    });
  }, [visibleData]);

  const closingPrices = useMemo(() => visibleData.map(candle => candle.close), [visibleData]);

  const movingAverageTraces = useMemo<PlotData[]>(() => {
    if (!visibleData || visibleData.length === 0) return [];

    const overlays: PlotData[] = [];

    MOVING_AVERAGE_WINDOWS.forEach((window, index) => {
      if (visibleData.length < window) {
        return;
      }

      const series = computeSMA(closingPrices, window);
      const color = MOVING_AVERAGE_COLORS[index % MOVING_AVERAGE_COLORS.length];

      overlays.push({
        type: 'scatter',
        mode: 'lines',
        x: timestamps,
        y: series,
        name: `MA(${window})`,
        line: { 
          color, 
          width: 1.5,
          shape: 'linear',
        },
        hovertemplate: `MA(${window}): %{y:,.2f}<extra></extra>`,
        legendgroup: 'overlays',
        opacity: 0.9,
      } as PlotData);
    });

    return overlays;
  }, [closingPrices, timestamps, visibleData]);

  const chartData = useMemo<PlotData[]>(() => {
    if (!visibleData || visibleData.length === 0) return [];

    const baseTraces: PlotData[] = [
      {
        type: 'candlestick',
        x: timestamps,
        open: visibleData.map(d => d.open),
        high: visibleData.map(d => d.high),
        low: visibleData.map(d => d.low),
        close: visibleData.map(d => d.close),
        increasing: {
          line: { color: '#0ecb81', width: 1 },
          fillcolor: '#0ecb81',
        },
        decreasing: {
          line: { color: '#f6465d', width: 1 },
          fillcolor: '#f6465d',
        },
        hovertemplate:
          '<b>%{x|%H:%M:%S}</b><br>' +
          'O: <b>%{open:,.2f}</b> | ' +
          'H: <b>%{high:,.2f}</b><br>' +
          'L: <b>%{low:,.2f}</b> | ' +
          'C: <b>%{close:,.2f}</b><extra></extra>',
        name: symbol,
        legendgroup: 'price',
        width: candleWidth,
        whiskerwidth: 0.2,
      } as PlotData,
      {
        type: 'bar',
        x: timestamps,
        y: visibleData.map(d => d.volume || 0),
        marker: {
          color: volumeColors,
          line: { width: 0 },
        },
        opacity: 1,
        yaxis: 'y2',
        name: 'Volume',
        legendgroup: 'volume',
        width: candleWidth,
        hovertemplate: '<b>Vol:</b> %{y:,.3f}<extra></extra>',
      } as PlotData,
    ];

    return [...baseTraces, ...movingAverageTraces];
  }, [candleWidth, movingAverageTraces, symbol, timestamps, visibleData, volumeColors]);

  const currentPrice = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return null;
    return visibleData[visibleData.length - 1].close;
  }, [visibleData]);

  const currentCandle = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return null;
    return visibleData[visibleData.length - 1];
  }, [visibleData]);

  const chartDataWithPriceLine = useMemo<PlotData[]>(() => {
    if (!currentPrice || !timestamps || timestamps.length === 0 || !currentCandle) return chartData;
    
    // Determine if price is bullish or bearish based on previous candle
    const prevCandle = visibleData.length >= 2 ? visibleData[visibleData.length - 2] : currentCandle;
    const isPriceUp = currentPrice >= prevCandle.close;
    const priceLineColor = isPriceUp ? '#0ecb81' : '#f6465d'; // Green if up, red if down
    
    // Dynamic last price line - matches candle color (red/green)
    const lastPriceLineTrace: PlotData = {
      type: 'scatter',
      mode: 'lines+text',
      x: [timestamps[0], timestamps[timestamps.length - 1]],
      y: [currentPrice, currentPrice],
      line: {
        color: priceLineColor,
        width: 2,
        dash: 'dash',
      },
      text: [``, `$${currentPrice.toFixed(2)}`], // Show price at the end
      textposition: 'middle right',
      textfont: {
        color: '#ffffff',
        size: 11,
        family: 'Roboto, monospace',
      },
      hovertemplate: `<b>Last Price:</b> $${currentPrice.toFixed(2)}<br><b>${isPriceUp ? '↑ Up' : '↓ Down'}</b><extra></extra>`,
      showlegend: false,
      name: 'Last Price',
      yaxis: 'y',
    } as PlotData;

    // Skip live candle indicator for 1s timeframe
    if (timeframe === '1s') {
      return [...chartData, lastPriceLineTrace];
    }
    
    // Live candle building indicator - vertical line showing real-time price
    const lastTimestamp = timestamps[timestamps.length - 1];
    const isBullish = currentCandle.close >= currentCandle.open;
    const lineColor = isBullish ? '#0ecb81' : '#f6465d'; // Green if bullish, red if bearish
    
    // Vertical line from open to current price (shows live building)
    const liveCandleIndicator: PlotData = {
      type: 'scatter',
      mode: 'lines+markers',
      x: [lastTimestamp, lastTimestamp],
      y: [currentCandle.open, currentPrice],
      line: {
        color: lineColor,
        width: 3,
      },
      marker: {
        size: 6,
        color: lineColor,
        symbol: 'circle',
        line: {
          color: '#161a1e',
          width: 1,
        },
      },
      hovertemplate: 
        `<b>Live Building</b><br>` +
        `Open: $${currentCandle.open.toFixed(2)}<br>` +
        `Current: $${currentPrice.toFixed(2)}<br>` +
        `Direction: ${isBullish ? '↑ Bullish' : '↓ Bearish'}<extra></extra>`,
      showlegend: false,
      name: 'Live Candle',
      yaxis: 'y',
    } as PlotData;

    // Pulse effect circle at current price
    const livePriceMarker: PlotData = {
      type: 'scatter',
      mode: 'markers',
      x: [lastTimestamp],
      y: [currentPrice],
      marker: {
        size: 10,
        color: lineColor,
        opacity: 0.6,
        symbol: 'circle',
        line: {
          color: lineColor,
          width: 2,
        },
      },
      hoverinfo: 'skip',
      showlegend: false,
      name: 'Live Price Marker',
      yaxis: 'y',
    } as PlotData;
    
    return [...chartData, lastPriceLineTrace, liveCandleIndicator, livePriceMarker];
  }, [chartData, currentPrice, timestamps, currentCandle, timeframe, visibleData]);

  // Calculate price range BEFORE layout (needed for Y-axis range)
  const priceRange = useMemo(() => {
    if (!visibleData || visibleData.length === 0) {
      return null;
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const candle of visibleData) {
      if (candle.low < min) min = candle.low;
      if (candle.high > max) max = candle.high;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }

    // Binance/TradingView style: 8% padding for clean visibility
    const spread = Math.max(max - min, max * 0.001);
    const pad = spread * 0.08; // 8% padding top/bottom
    const lower = min - pad;
    const upper = max + pad;

    return [lower, upper] as [number, number];
  }, [visibleData]);

  const layout = useMemo(() => {
    // Dynamic bargap based on zoom level - smooth continuous scaling
    let bargap: number;
    if (timeframe === '1s') {
      // 1 second: Minimal spacing like Binance (consistent tight gaps)
      bargap = 0.15; // Optimal for 1s - minimal consistent spacing
    } else {
      if (visibleCandleCount) {
        // Binance/Groww style: very tight spacing for professional look
        // Maps: 20 candles -> 0.25, 50 -> 0.18, 100 -> 0.12, 200 -> 0.08, 500+ -> 0.05
        const minBargap = 0.05; // Extremely tight for Binance/Groww professional look
        const maxBargap = 0.25; // Much lower max for closer packed candles
        
        if (visibleCandleCount <= 20) {
          // Very zoomed in - maximum spacing
          bargap = maxBargap;
        } else if (visibleCandleCount >= 500) {
          // Very zoomed out - minimum spacing
          bargap = minBargap;
        } else {
          // Smooth logarithmic interpolation
          const logMin = Math.log(20);
          const logMax = Math.log(500);
          const logCurrent = Math.log(visibleCandleCount);
          const normalizedPosition = (logCurrent - logMin) / (logMax - logMin);
          
          // Interpolate bargap (inverted - more candles = less spacing)
          bargap = maxBargap - (normalizedPosition * (maxBargap - minBargap));
        }
      } else {
        bargap = 0.1; // Default bargap - very tight for Binance/Groww style
      }
    }
    
    return {
    paper_bgcolor: '#161a1e',
    plot_bgcolor: '#161a1e',
    font: { color: '#848e9c', family: 'Roboto, sans-serif' },
    xaxis: {
      gridcolor: 'rgba(43, 47, 53, 0.5)',
      showgrid: true,
      type: 'date' as const,
      zeroline: false,
      ticksuffix: ' ',
      rangeslider: { visible: false },
      showspikes: true,
      spikecolor: 'rgba(250, 204, 21, 0.6)',
      spikethickness: 1,
      spikemode: 'across',
      tickfont: { size: 11, color: '#848e9c' },
      tickformat: '%H:%M',
      fixedrange: false, // Allow X-axis zoom and pan - Binance style
    },
    yaxis: {
      gridcolor: 'rgba(43, 47, 53, 0.5)',
      showgrid: true,
      zeroline: false,
      tickprefix: '',
      ticksuffix: ' ',
      domain: [0.22, 1],
      color: '#848e9c',
      tickfont: { size: 11, color: '#848e9c' },
      side: 'right' as const,
      fixedrange: true, // Lock Y-axis - Binance/TradingView style
      autorange: true, // Auto-scale to visible data
      range: priceRange || undefined, // Use computed price range
    },
    yaxis2: {
      domain: [0, 0.18],
      showgrid: false,
      zeroline: false,
      tickfont: { color: '#848e9c', size: 9 },
      ticksuffix: ' ',
      side: 'right' as const,
      fixedrange: true, // Lock volume Y-axis too
      autorange: true,
    },
    legend: {
      orientation: 'h',
      yanchor: 'top',
      y: 1,
      xanchor: 'left',
      x: 0,
      font: { color: '#848e9c', size: 10 },
      bgcolor: 'rgba(22, 26, 30, 0.0)',
    },
    margin: { l: 10, r: 65, t: 30, b: 35 },
    height: 550,
    hovermode: 'x unified' as const,
    dragmode: 'pan' as const,
    showlegend: true,
    bargap,
    bargroupgap: 0,
    hoverlabel: {
      bgcolor: '#2b2f35',
      bordercolor: '#848e9c',
      font: { color: '#ffffff', size: 11 },
    },
    uirevision: `price-chart-${symbol}-${timeframe}`,
    datarevision: dataLength,
    transition: {
      duration: 150, // Ultra-fast for rapid price updates (Binance-like)
      easing: 'ease-out',
      ordering: 'traces first' as const,
    },
  };
  }, [symbol, timeframe, dataLength, visibleCandleCount, priceRange]);

  useEffect(() => {
    return () => {
      plotRef.current = null;
      // Cleanup zoom timeout on unmount
      if (zoomTimeoutRef.current) {
        clearTimeout(zoomTimeoutRef.current);
      }
    };
  }, []);

  const config = useMemo(() => ({
    displayModeBar: false,
    displaylogo: false,
    responsive: true,
    scrollZoom: true, // Enable scroll zoom
    doubleClick: 'reset' as const,
    frameMargins: 0,
    staticPlot: false,
    modeBarButtonsToRemove: ['pan2d', 'select2d', 'lasso2d', 'autoScale2d'],
    modeBarButtonsToAdd: [],
  }), []);

  const handleRelayout = useCallback((event: PlotRelayoutEvent) => {
    const start = (event['xaxis.range[0]'] ?? event['xaxis.range0']) as string | undefined;
    const end = (event['xaxis.range[1]'] ?? event['xaxis.range1']) as string | undefined;

    if (!start || !end) {
      // Reset to default on autorange
      if (event['xaxis.autorange']) {
        setVisibleCandleCount(undefined);
        const width = computeCandleWidth(visibleData.map(c => c.ts), timeframe);
        setCandleWidth(width);
      }
      return;
    }

    const startMs = Date.parse(start);
    const endMs = Date.parse(end);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return;
    }

    // Debounce rapid zoom events for better performance
    if (zoomTimeoutRef.current) {
      clearTimeout(zoomTimeoutRef.current);
    }

    zoomTimeoutRef.current = setTimeout(() => {
      const visibleCandles = visibleData.filter(candle => {
        const ts = Date.parse(candle.ts);
        return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
      });

      if (visibleCandles.length < 2) {
        return;
      }

      // Update visible candle count for dynamic width/bargap
      setVisibleCandleCount(visibleCandles.length);
      
      // Compute width based on zoom level with smooth logarithmic scaling
      const updatedWidth = computeCandleWidth(visibleCandles.map(candle => candle.ts), timeframe, visibleCandles.length);

      if (typeof updatedWidth === 'number' && Number.isFinite(updatedWidth)) {
        setCandleWidth(updatedWidth);
      }
      
      // Auto-update Y-axis range based on visible candles (Binance/TradingView style)
      if (plotRef.current && visibleCandles.length > 0) {
        let minPrice = Number.POSITIVE_INFINITY;
        let maxPrice = Number.NEGATIVE_INFINITY;
        
        for (const candle of visibleCandles) {
          if (candle.low < minPrice) minPrice = candle.low;
          if (candle.high > maxPrice) maxPrice = candle.high;
        }
        
        if (Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
          const priceSpread = Math.max(maxPrice - minPrice, maxPrice * 0.001);
          const padding = priceSpread * 0.08; // 8% padding for better visibility
          
          // Update Y-axis range without triggering relayout loop
          const update = {
            'yaxis.range': [minPrice - padding, maxPrice + padding],
            'yaxis.autorange': false,
          };
          
          if (plotRef.current.layout) {
            Object.assign(plotRef.current.layout, update);
          }
        }
      }
    }, 30); // Reduced to 30ms for more responsive zoom
  }, [visibleData, timeframe]);

  if (visibleData.length === 0) {
    return (
      <div className="h-[480px] flex items-center justify-center text-muted-foreground bg-slate-950/50 rounded-lg">
        <div className="text-center">
          <p className="text-lg">No data available</p>
          <p className="text-sm text-slate-500 mt-1">Start streaming to see live data</p>
        </div>
      </div>
    );
  }

  return (
    <Plot
      key={`chart-${symbol}-${timeframe}`}
      data={chartDataWithPriceLine}
      layout={layout}
      config={config}
      onInitialized={figure => {
        plotRef.current = figure as PlotlyHTMLElement;
      }}
      onUpdate={figure => {
        plotRef.current = figure as PlotlyHTMLElement;
      }}
      onRelayout={handleRelayout}
      style={{ width: '100%', height: '100%' }}
      useResizeHandler
      divId={`plotly-chart-${symbol}-${timeframe}`}
      revision={dataLength}
    />
  );
}, (prevProps, nextProps) => {
  if (prevProps.symbol !== nextProps.symbol || prevProps.timeframe !== nextProps.timeframe) {
    return false;
  }

  if (Math.abs(prevProps.data.length - nextProps.data.length) > 2) {
    return false;
  }

  if (prevProps.data.length === 0 && nextProps.data.length === 0) {
    return true;
  }

  if (prevProps.data.length === 0 || nextProps.data.length === 0) {
    return false;
  }

  const prevLast = prevProps.data[prevProps.data.length - 1];
  const nextLast = nextProps.data[nextProps.data.length - 1];

  if (!prevLast || !nextLast) {
    return false;
  }

  // Ultra-sensitive thresholds for rapid Binance-like updates
  const priceThreshold = 0.0001; // Detect tiniest price changes
  const volumeThreshold = 0.0001;
  
  const areEqual = (
    prevLast.ts === nextLast.ts &&
    Math.abs(prevLast.open - nextLast.open) < priceThreshold &&
    Math.abs(prevLast.high - nextLast.high) < priceThreshold &&
    Math.abs(prevLast.low - nextLast.low) < priceThreshold &&
    Math.abs(prevLast.close - nextLast.close) < priceThreshold &&
    Math.abs((prevLast.volume || 0) - (nextLast.volume || 0)) < volumeThreshold
  );

  return areEqual;
});

ChartCanvas.displayName = 'ChartCanvas';

const PriceChartComponent = ({
  data,
  symbol,
  timeframe,
  onTimeframeChange,
  timeframeOptions = DEFAULT_TIMEFRAME_OPTIONS,
  isLive = false,
  onStartLive,
  onStopLive,
  showLiveToggle = true,
  tickerData = null,
}: PriceChartProps) => {
  const [isWatchlisted, setIsWatchlisted] = useState(false);

  const meta = useMemo(() => getAssetMeta(symbol), [symbol]);
  const liveTicker = isLive && tickerData ? tickerData : null;

  const summary = useMemo(() => {
    if (!liveTicker) {
      return null;
    }

    return {
      price: liveTicker.lastPrice,
      change: liveTicker.priceChange,
      changePercent: liveTicker.priceChangePercent,
      high: liveTicker.highPrice,
      low: liveTicker.lowPrice,
      volume: liveTicker.volume,
    };
  }, [liveTicker]);

  const hasLiveSummary = Boolean(summary);

  const handleToggleWatchlist = () => setIsWatchlisted(prev => !prev);

  const handleLiveToggle = () => {
    if (isLive) {
      onStopLive?.();
    } else {
      onStartLive?.();
    }
  };

  const handleTimeframeClick = (value: string) => {
    if (value !== timeframe) {
      onTimeframeChange?.(value);
    }
  };

  const changeBadgeClass = hasLiveSummary
    ? summary!.changePercent >= 0
      ? 'bg-emerald-500/10 text-emerald-400'
      : 'bg-rose-500/10 text-rose-400'
    : 'bg-slate-800 text-muted-foreground';

  const stats = useMemo(
    () => [
      {
        label: 'Market cap',
        value:
          hasLiveSummary && typeof meta.marketCap === 'number'
            ? formatCompactCurrency(meta.marketCap)
            : '--',
        change:
          hasLiveSummary && typeof meta.marketCapChange === 'number'
            ? meta.marketCapChange
            : undefined,
      },
      {
        label: 'Volume (24h)',
        value:
          hasLiveSummary && typeof meta.volume24h === 'number'
            ? formatCompactCurrency(meta.volume24h)
            : '--',
        change:
          hasLiveSummary && typeof meta.volume24hChange === 'number'
            ? meta.volume24hChange
            : undefined,
      },
      {
        label: 'FDV',
        value:
          hasLiveSummary && typeof meta.fullyDilutedValuation === 'number'
            ? formatCompactCurrency(meta.fullyDilutedValuation)
            : '--',
      },
      {
        label: 'Vol/Mkt Cap (24h)',
        value:
          hasLiveSummary && meta.marketCap && meta.volume24h
            ? `${formatNumber((meta.volume24h / meta.marketCap) * 100, 2)}%`
            : '--',
        muted: true,
      },
      {
        label: 'Total supply',
        value:
          meta.totalSupply !== undefined && meta.totalSupply !== null
            ? `${formatCompactNumber(meta.totalSupply)} ${meta.ticker}`
            : '∞',
      },
      {
        label: 'Circulating supply',
        value:
          meta.circulatingSupply !== undefined && meta.circulatingSupply !== null
            ? `${formatCompactNumber(meta.circulatingSupply)} ${meta.ticker}`
            : '--',
      },
    ],
    [meta, hasLiveSummary]
  );

  return (
    <Card className="bg-gradient-card border-border/50 shadow-card overflow-hidden">
      <CardHeader className="space-y-6 bg-slate-900/40 border-b border-border/40">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <AssetLogo symbol={symbol} size="lg" />
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xl font-semibold text-foreground">
                  {meta.name}
                </span>
                <Badge variant="secondary">{meta.ticker}</Badge>
                {typeof meta.rank === 'number' && (
                  <Badge variant="outline">#{meta.rank}</Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {meta.watchlistCount ? `${meta.watchlistCount} watchlists` : 'Watchlist data unavailable'}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'rounded-full border border-border/60 bg-slate-950/40',
              isWatchlisted && 'text-yellow-400'
            )}
            onClick={handleToggleWatchlist}
            aria-label="Toggle watchlist"
          >
            {isWatchlisted ? <Star className="h-5 w-5 fill-yellow-400" /> : <StarOff className="h-5 w-5" />}
          </Button>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="text-4xl font-semibold tracking-tight text-foreground">
              {hasLiveSummary ? `$${formatPrice(summary!.price)}` : '--'}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium text-xs',
                  changeBadgeClass
                )}
              >
                {hasLiveSummary ? (
                  summary!.changePercent >= 0 ? (
                    <ArrowUpRight className="h-4 w-4" />
                  ) : (
                    <ArrowDownRight className="h-4 w-4" />
                  )
                ) : (
                  <Dot className="h-4 w-4" />
                )}
                {hasLiveSummary ? formatSignedPercent(summary!.changePercent) : '--'}
              </span>
              <span className="text-xs text-muted-foreground">(24h)</span>
            </div>
            <div className="text-xs text-muted-foreground">
              24h Low: {hasLiveSummary ? `$${formatPrice(summary!.low)}` : '--'} · High: {hasLiveSummary ? `$${formatPrice(summary!.high)}` : '--'} · Volume: {hasLiveSummary ? formatCompactNumber(summary!.volume, 2) : '--'}
            </div>
          </div>

          {showLiveToggle && (
            <div className="flex items-center gap-3">
              <Badge
                variant="outline"
                className={cn(
                  'flex items-center gap-1 border border-border/60 text-xs',
                  isLive ? 'text-emerald-400 border-emerald-500/40' : 'text-muted-foreground'
                )}
              >
                <Dot className={cn('h-4 w-4', isLive ? 'text-emerald-400 animate-pulse' : 'text-muted-foreground')} />
                {isLive ? 'Live updating' : 'Live paused'}
              </Badge>
              <Button
                variant={isLive ? 'secondary' : 'default'}
                onClick={handleLiveToggle}
                className="min-w-[104px]"
              >
                {isLive ? 'Stop live' : 'Start live'}
              </Button>
            </div>
          )}
        </div>

        {hasLiveSummary ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {stats.map((stat, index) => (
              <div key={index} className="rounded-lg border border-border/40 bg-slate-900/60 p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  {stat.label}
                </div>
                <div className={cn('text-sm font-semibold text-foreground', stat.muted && 'text-muted-foreground')}>
                  {stat.value}
                </div>
                {typeof stat.change === 'number' && !stat.muted && (
                  <div
                    className={cn(
                      'text-[11px] font-medium flex items-center gap-1',
                      stat.change >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    )}
                  >
                    {stat.change >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {formatSignedPercent(stat.change)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/40 bg-slate-900/40 p-4 text-xs text-muted-foreground">
            Live market stats are available when streaming is active.
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-slate-900/60 p-1">
            {timeframeOptions.map(option => (
              <button
                key={option.value}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded-full transition-colors',
                  timeframe === option.value
                    ? 'bg-slate-800 text-foreground shadow'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => handleTimeframeClick(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            Drag to pan · Scroll to zoom · Double-click to reset
          </div>
        </div>
        <ChartCanvas data={data} symbol={symbol} timeframe={timeframe} />
      </CardContent>
    </Card>
  );
};

export const PriceChart = PriceChartComponent;
