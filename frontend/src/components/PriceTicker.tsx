import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface PriceTickerProps {
  symbol: string;
  price: number;
  priceChange: number;
  priceChangePercent: number;
}

export const PriceTicker = ({ symbol, price, priceChange, priceChangePercent }: PriceTickerProps) => {
  const [flashClass, setFlashClass] = useState('');
  const [prevPrice, setPrevPrice] = useState(price);

  useEffect(() => {
    if (price !== prevPrice) {
      // Flash green for up, red for down
      setFlashClass(price > prevPrice ? 'flash-green' : 'flash-red');
      setPrevPrice(price);

      // Remove flash after animation
      const timer = setTimeout(() => setFlashClass(''), 500);
      return () => clearTimeout(timer);
    }
  }, [price, prevPrice]);

  const isPositive = priceChange >= 0;
  const priceColor = isPositive ? 'text-success' : 'text-destructive';
  const bgColor = isPositive ? 'bg-success/10' : 'bg-destructive/10';

  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded-lg ${bgColor} transition-all duration-200 ${flashClass}`}>
      <div className="flex-shrink-0">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="text-xs font-bold text-primary">{symbol.replace('USDT', '')}</span>
        </div>
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-lg font-bold ${priceColor} transition-colors duration-200`}>
            ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {isPositive ? (
            <TrendingUp className={`w-4 h-4 ${priceColor}`} />
          ) : (
            <TrendingDown className={`w-4 h-4 ${priceColor}`} />
          )}
        </div>
        <div className={`text-xs ${priceColor} font-medium`}>
          {isPositive ? '+' : ''}{priceChange.toFixed(2)} ({isPositive ? '+' : ''}{priceChangePercent.toFixed(2)}%) 24h
        </div>
      </div>
    </div>
  );
};
