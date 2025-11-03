import { Activity, TrendingUp } from 'lucide-react';
import { PriceTicker } from './PriceTicker';

interface TickerData {
  priceChange: number;
  priceChangePercent: number;
  lastPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

interface NavbarProps {
  isStreaming: boolean;
  tickCount: number;
  selectedSymbols: string[];
  tickerData: Record<string, TickerData>;
}

export const Navbar = ({ isStreaming, tickCount, selectedSymbols, tickerData }: NavbarProps) => {
  return (
    <nav className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-lg bg-gradient-primary flex items-center justify-center">
            <TrendingUp className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Quant Analytics</h1>
            <p className="text-xs text-muted-foreground">Real-time Trading Dashboard</p>
          </div>
        </div>
        
        {/* Live Price Tickers */}
        {isStreaming && selectedSymbols.length > 0 && (
          <div className="flex items-center gap-3 flex-1 justify-center overflow-x-auto">
            {selectedSymbols.map(symbol => {
              const ticker = tickerData[symbol];
              if (!ticker) return null;
              
              return (
                <PriceTicker
                  key={symbol}
                  symbol={symbol}
                  price={ticker.lastPrice}
                  priceChange={ticker.priceChange}
                  priceChangePercent={ticker.priceChangePercent}
                />
              );
            })}
          </div>
        )}
        
        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/50">
            <div className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-success animate-pulse' : 'bg-muted'}`} />
            <span className="text-sm font-medium">
              {isStreaming ? 'Live' : 'Offline'}
            </span>
          </div>
          
          {isStreaming && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="w-4 h-4" />
              <span className="font-mono">{tickCount.toLocaleString()}</span>
              <span>ticks</span>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
};
